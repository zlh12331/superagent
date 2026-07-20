// src/main/__tests__/pg-controller.test.ts
// pg-controller 单元测试
// 注意：node:child_process 与 node:net 都用 vi.mock 替换，避免真实进程与端口占用
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Vitest 4 vi.mock 会被 hoist，必须用 vi.hoisted 导出 mock 对象
const { mockSpawn, mockChildProcess, mockNet, mockSocket, defaultKill, defaultSocketOn } =
  vi.hoisted(() => {
    // 模拟 child process 实例
    const mockChildProcess = {
      pid: 12345,
      killed: false,
      kill: vi.fn((_signal?: string) => {
        mockChildProcess.killed = true;
        // 模拟 exit 事件
        setTimeout(() => {
          mockChildProcess.listeners?.['exit']?.(0, null);
        }, 10);
        return true;
      }),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        // 保存 listener 以便测试触发
        if (!mockChildProcess.listeners) {
          mockChildProcess.listeners = {};
        }
        mockChildProcess.listeners[event] = listener;
      }),
      // stop() 使用 child.once('exit', ...)，需要 mock 实现
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (!mockChildProcess.listeners) {
          mockChildProcess.listeners = {};
        }
        mockChildProcess.listeners[event] = listener;
      }),
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      listeners: {} as Record<string, (...args: unknown[]) => void>,
    };

    // 保存默认 kill 实现，便于 beforeEach 恢复（test 4 会覆盖 kill）
    const defaultKill = mockChildProcess.kill;

    const mockSpawn = vi.fn(() => mockChildProcess);

    // 模拟 net.connect（TCP 端口探活）
    const mockSocket = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        if (event === 'connect') {
          // 默认立即连接成功
          setTimeout(() => listener(), 1);
        }
        if (event === 'error') {
          // 保存 error listener 以便测试触发
          mockSocket.errorListener = listener;
        }
      }),
      destroy: vi.fn(),
      errorListener: null as ((err: Error) => void) | null,
    };

    // 保存默认 socket.on 实现，便于 beforeEach 恢复（test 2/7 会覆盖 on）
    const defaultSocketOn = mockSocket.on;

    const mockNet = {
      connect: vi.fn(() => mockSocket),
    };

    return { mockSpawn, mockChildProcess, mockNet, mockSocket, defaultKill, defaultSocketOn };
  });

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('node:net', () => ({ createConnection: mockNet.connect }));

import { PgController } from '../infra/pg/pg-controller';

describe('PgController', () => {
  let controller: PgController;

  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 mock 状态
    mockChildProcess.killed = false;
    mockChildProcess.listeners = {};
    mockSocket.errorListener = null;
    // 恢复默认 mock 实现（部分测试会覆盖 kill / socket.on）
    mockChildProcess.kill = defaultKill;
    mockSocket.on = defaultSocketOn;
    controller = new PgController({
      binaryPath: '/usr/bin/postgres',
      dataDir: '/tmp/pgdata',
      port: 5433,
    });
  });

  afterEach(() => {
    controller.removeAllListeners();
  });

  it('start() 启动 PG 进程并发射 running 状态', async () => {
    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();

    expect(mockSpawn).toHaveBeenCalledWith(
      '/usr/bin/postgres',
      ['-D', '/tmp/pgdata', '-p', '5433'],
      expect.objectContaining({ stdio: expect.anything() }),
    );
    // 等待 TCP 探活成功后状态变为 running
    expect(statusListener).toHaveBeenCalledWith({ status: 'running', pid: 12345 });
  });

  it('start() 在端口探活失败时抛 PG_START_FAILED', async () => {
    // 模拟端口连接失败
    mockSocket.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        setTimeout(() => listener(new Error('ECONNREFUSED')), 1);
      }
    });

    // 使用 fake timers 加速 waitForPort 的 30 次重试（30s × 1s 间隔）
    vi.useFakeTimers();
    const startPromise = controller.start();
    // 先附加 rejection 断言，避免推进定时器时 start() 拒绝产生未处理拒绝
    const rejectionAssertion = expect(startPromise).rejects.toThrow();
    // 推进 35 秒，覆盖全部 30 次重试（30 × (1ms 探活 + 1s 间隔) ≈ 30s）
    await vi.advanceTimersByTimeAsync(35000);
    await rejectionAssertion;
    vi.useRealTimers();
    // 验证进程被 kill
    expect(mockChildProcess.kill).toHaveBeenCalled();
  });

  it('stop() 发送 SIGTERM 并等待 exit', async () => {
    await controller.start();
    await controller.stop();

    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('stop() 在 5 秒后强制 SIGKILL', async () => {
    // 模拟进程不响应 SIGTERM（不触发 exit 事件），但响应 SIGKILL
    mockChildProcess.kill = vi.fn((signal?: string) => {
      if (signal === 'SIGTERM') {
        // 不触发 exit 事件，等超时
        return true;
      }
      // SIGKILL：模拟进程被强制终止，触发 exit 事件以便 stop() 完成
      mockChildProcess.killed = true;
      setTimeout(() => {
        mockChildProcess.listeners?.['exit']?.(0, null);
      }, 0);
      return true;
    });

    await controller.start();
    // 使用 fake timers 加速超时
    vi.useFakeTimers();
    const stopPromise = controller.stop();
    // 推进 6 秒，覆盖 5s SIGKILL 超时 + exit 事件触发
    vi.advanceTimersByTime(6000);
    await stopPromise;
    vi.useRealTimers();

    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGTERM');
    expect(mockChildProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('进程意外退出时发射 crashed 状态', async () => {
    const statusListener = vi.fn();
    controller.on('status-change', statusListener);

    await controller.start();
    // 模拟进程崩溃（触发 exit 事件非 0 退出码）
    mockChildProcess.listeners['exit']?.(1, null);

    expect(statusListener).toHaveBeenCalledWith({ status: 'crashed', code: 1 });
  });

  it('isHealthy() 返回端口探活结果', async () => {
    await controller.start();
    const healthy = await controller.isHealthy();
    expect(healthy).toBe(true);
    expect(mockNet.connect).toHaveBeenCalledWith({ host: 'localhost', port: 5433 });
  });

  it('isHealthy() 端口不可达时返回 false', async () => {
    mockSocket.on = vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (event === 'error') {
        setTimeout(() => listener(new Error('ECONNREFUSED')), 1);
      }
    });

    const healthy = await controller.isHealthy();
    expect(healthy).toBe(false);
  });
});
