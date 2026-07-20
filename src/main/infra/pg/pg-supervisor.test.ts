// src/main/infra/pg/pg-supervisor.test.ts
// pg-supervisor 单元测试
// 设计文档 §7.8 PG 子进程健康监控 + 指数退避重启策略
//
// 测试策略：
// - 依赖注入：传入 MockPgController（extends EventEmitter）模拟 controller 行为
// - fake timers：加速 5s/10s/30s 退避等待
// - 不依赖真实 PG 进程：通过 emit('status-change', { status: 'crashed' }) 模拟崩溃

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PgController } from './pg-controller';
import { PgSupervisor } from './pg-supervisor';
import type { PgStatusChangeEvent } from './pg-types';

/**
 * 模拟 PgController.start 成功时的 emit 行为（starting → running）
 *
 * 抽成模块级函数的原因：
 * - 多个测试需要 `mockImplementationOnce(startSuccess)` 保留默认 emit 行为
 * - 不能用 `mockResolvedValueOnce(undefined)`：它会覆盖默认实现导致不 emit 'running'
 * - 这里不直接引用 controller，而是通过闭包捕获传入的 controller 实例
 *
 * @param controller 目标 MockPgController 实例（用于 emit 事件）
 */
function makeStartSuccess(controller: MockPgController): () => Promise<void> {
  return async () => {
    queueMicrotask(() => {
      controller.emit('status-change', { status: 'starting' } satisfies PgStatusChangeEvent);
      controller.emit('status-change', {
        status: 'running',
        pid: 12345,
      } satisfies PgStatusChangeEvent);
    });
  };
}

/**
 * Mock PgController：extends EventEmitter，提供与 PgController 相同的实例方法
 *
 * 用 `as unknown as PgController` 转换：测试中只用到 start/stop/isHealthy/getStatus + EventEmitter 方法
 */
class MockPgController extends EventEmitter {
  start = vi.fn(async () => {
    // 模拟 PgController.start 内部 emit starting → running
    queueMicrotask(() => {
      this.emit('status-change', { status: 'starting' } satisfies PgStatusChangeEvent);
      this.emit('status-change', { status: 'running', pid: 12345 } satisfies PgStatusChangeEvent);
    });
  });

  stop = vi.fn(async () => {
    // 模拟 PgController.stop 内部 emit stopping → stopped
    queueMicrotask(() => {
      this.emit('status-change', { status: 'stopping' } satisfies PgStatusChangeEvent);
      this.emit('status-change', { status: 'stopped' } satisfies PgStatusChangeEvent);
    });
  });

  isHealthy = vi.fn(async () => true);

  getStatus = vi.fn(() => 'stopped' as const);

  /** 模拟 PG 进程意外退出（emit crashed 事件） */
  simulateCrash(code = 1): void {
    this.emit('status-change', { status: 'crashed', code } satisfies PgStatusChangeEvent);
  }
}

describe('PgSupervisor', () => {
  let mockController: MockPgController;
  let supervisor: PgSupervisor;

  beforeEach(() => {
    vi.useFakeTimers();
    mockController = new MockPgController();
    supervisor = new PgSupervisor(mockController as unknown as PgController);
  });

  afterEach(() => {
    vi.useRealTimers();
    supervisor.removeAllListeners();
  });

  it('start() 委托 controller.start() 并透传状态事件', async () => {
    const statusListener = vi.fn();
    supervisor.on('status-change', statusListener);

    await supervisor.start();

    expect(mockController.start).toHaveBeenCalledTimes(1);
    // supervisor 自己先 emit 'starting'（start 内部重置后），然后透传 controller 的 'starting' → 'running'
    // 注意：queueMicrotask 让 controller 的 emit 在 start 返回后才发生
    // 所以这里只需验证最终状态：透传到 running
    expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({ status: 'starting' }));
    expect(statusListener).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', pid: 12345 }),
    );
    expect(supervisor.getStatus()).toBe('running');
  });

  it('stop() 委托 controller.stop() 且不触发自动重启', async () => {
    await supervisor.start();
    // 重置 listener（start 期间的 emit 不算）
    const statusListener = vi.fn();
    supervisor.on('status-change', statusListener);

    await supervisor.stop();

    expect(mockController.stop).toHaveBeenCalledTimes(1);
    // stop 期间 controller emit 'stopping' → 'stopped'，supervisor 透传
    expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopping' }));
    expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({ status: 'stopped' }));
    expect(supervisor.getStatus()).toBe('stopped');
    // 不应出现 'restarting' / 'dead' 状态
    expect(statusListener).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: 'restarting' }),
    );
  });

  it('crashed 后自动等待 5s 后重启（第 1 次退避）', async () => {
    const statusListener = vi.fn();
    supervisor.on('status-change', statusListener);

    await supervisor.start();
    statusListener.mockClear();

    // 模拟崩溃
    mockController.simulateCrash(1);

    // 立即透传 crashed，并 emit 'restarting' { attempt: 1 }
    expect(statusListener).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'crashed', code: 1 }),
    );
    expect(statusListener).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'restarting', attempt: 1 }),
    );
    expect(supervisor.getStatus()).toBe('restarting');

    // 5s 前不调用 controller.start
    expect(mockController.start).toHaveBeenCalledTimes(1); // 仅初始 start
    vi.advanceTimersByTimeAsync(4999);
    expect(mockController.start).toHaveBeenCalledTimes(1);

    // 5s 后触发第 1 次重启
    await vi.advanceTimersByTimeAsync(1);
    expect(mockController.start).toHaveBeenCalledTimes(2);

    // 重启成功后 attempts 重置
    expect(supervisor.getStatus()).toBe('running');
  });

  it('第 1 次重启失败 → 10s 后第 2 次重启', async () => {
    // 用 makeStartSuccess 保留 emit 'starting' → 'running' 的默认行为
    // （mockResolvedValueOnce(undefined) 会覆盖默认实现导致不 emit，后续状态断言失败）
    const startSuccess = makeStartSuccess(mockController);

    // 让 controller.start 在第 1 次重启时抛错
    mockController.start
      .mockImplementationOnce(startSuccess) // 初始 start 成功
      .mockRejectedValueOnce(new Error('PG 启动失败 1'))
      .mockImplementationOnce(startSuccess); // 第 2 次重启成功

    await supervisor.start();
    mockController.simulateCrash();

    // 第 1 次：5s 后尝试，失败
    // advanceTimersByTimeAsync 内部已 flush microtask，无需额外 runAllTicks
    await vi.advanceTimersByTimeAsync(5000);
    expect(supervisor.getStatus()).toBe('restarting');
    // 第 2 次：10s 后尝试，成功
    await vi.advanceTimersByTimeAsync(10000);
    expect(supervisor.getStatus()).toBe('running');
    expect(mockController.start).toHaveBeenCalledTimes(3); // 初始 + 重启 1 + 重启 2
  });

  it('3 次重启均失败 → 进入 dead 状态', async () => {
    // 初始 start 用 makeStartSuccess 保留 emit 'starting' → 'running' 的默认行为
    // （mockResolvedValueOnce(undefined) 会覆盖默认实现导致 supervisor.currentStatus 卡在 'starting'）
    const startSuccess = makeStartSuccess(mockController);

    // 让 controller.start 在所有重启尝试时都抛错
    mockController.start
      .mockImplementationOnce(startSuccess) // 初始 start 成功
      .mockRejectedValueOnce(new Error('重启 1 失败'))
      .mockRejectedValueOnce(new Error('重启 2 失败'))
      .mockRejectedValueOnce(new Error('重启 3 失败'));

    const statusListener = vi.fn();
    supervisor.on('status-change', statusListener);

    await supervisor.start();
    statusListener.mockClear();
    mockController.simulateCrash();

    // 第 1 次：5s 后
    // advanceTimersByTimeAsync 内部已 flush microtask，无需额外 runAllTicks
    await vi.advanceTimersByTimeAsync(5000);
    expect(supervisor.getStatus()).toBe('restarting');

    // 第 2 次：10s 后
    await vi.advanceTimersByTimeAsync(10000);
    expect(supervisor.getStatus()).toBe('restarting');

    // 第 3 次：30s 后
    await vi.advanceTimersByTimeAsync(30000);
    // 3 次均失败后进入 dead
    expect(supervisor.getStatus()).toBe('dead');
    expect(statusListener).toHaveBeenCalledWith(expect.objectContaining({ status: 'dead' }));
    // 不再尝试第 4 次
    expect(mockController.start).toHaveBeenCalledTimes(4); // 初始 + 3 次重启尝试
    vi.advanceTimersByTime(60000);
    expect(mockController.start).toHaveBeenCalledTimes(4);
  });

  it('重启成功后 attempts 重置，下次崩溃重新从 5s 开始', async () => {
    // 用 makeStartSuccess 保留 emit 'starting' → 'running' 的默认行为
    // （mockResolvedValueOnce(undefined) 会覆盖默认实现导致 supervisor.currentStatus 不变）
    const startSuccess = makeStartSuccess(mockController);

    mockController.start
      .mockImplementationOnce(startSuccess) // 初始 start 成功
      .mockImplementationOnce(startSuccess); // 第 1 次重启成功

    await supervisor.start();

    // 第 1 次崩溃 → 5s 后重启成功
    mockController.simulateCrash();
    // advanceTimersByTimeAsync 内部已 flush microtask，无需额外 runAllTicks
    await vi.advanceTimersByTimeAsync(5000);
    expect(supervisor.getStatus()).toBe('running');

    // 第 2 次崩溃 → 应从 5s 开始（attempts 已重置）
    const statusListener = vi.fn();
    supervisor.on('status-change', statusListener);
    mockController.simulateCrash();
    expect(statusListener).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'restarting', attempt: 1 }),
    );
  });

  it('stop() 期间触发 crashed 不重启', async () => {
    await supervisor.start();

    // 模拟 stop 期间发生 crashed（虽然实际 stop 中很少 crash，但需要测试 isStopping 标记）
    // 通过直接修改 supervisor 内部状态：先调用 stop()，但 mock 让 controller.stop 慢
    let stopResolve!: () => void;
    mockController.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          stopResolve = resolve;
        }),
    );

    const stopPromise = supervisor.stop();
    // stop 期间发生 crashed
    mockController.simulateCrash(1);
    // 完成 stop
    stopResolve();
    await stopPromise;

    // 推进时间，不应触发自动重启
    await vi.advanceTimersByTimeAsync(60000);
    expect(mockController.start).toHaveBeenCalledTimes(1); // 仅初始 start
  });

  it('restarting 期间调用 stop() 取消等待中的重启定时器', async () => {
    await supervisor.start();
    mockController.simulateCrash();

    // 此时 supervisor 在等待 5s 重启
    expect(supervisor.getStatus()).toBe('restarting');

    // 用户调用 stop()，应取消重启定时器
    await supervisor.stop();

    // 推进时间，不应触发自动重启
    await vi.advanceTimersByTimeAsync(60000);
    // 仅初始 start 1 次，重启未触发
    expect(mockController.start).toHaveBeenCalledTimes(1);
    expect(supervisor.getStatus()).toBe('stopped');
  });

  it('isHealthy() 委托 controller.isHealthy()', async () => {
    mockController.isHealthy.mockResolvedValue(true);
    const result = await supervisor.isHealthy();
    expect(result).toBe(true);
    expect(mockController.isHealthy).toHaveBeenCalled();
  });

  it('透传 controller 的 running 事件（含 pid）', async () => {
    const statusListener = vi.fn();
    supervisor.on('status-change', statusListener);

    await supervisor.start();

    expect(statusListener).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'running', pid: 12345 }),
    );
  });
});
