// src/main/infra/ai/agent/stall-watchdog.test.ts
// StallWatchdog 单测：停滞检测 + 重试（无进展 abort / 工具飞行暂停 / 父取消不重试）
//
// 测试要点：
// 1. 正常进度刷新 → 不触发停滞，返回结果
// 2. 无进展超时 → abort 当前尝试 + 重试成功
// 3. 停滞重试耗尽 → 抛耗尽错误
// 4. tool-start 暂停计时（长跑工具不误判）
// 5. 父取消 → 立即抛且不重试

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StallWatchdog, type WatchdogEvent } from './stall-watchdog';

describe('StallWatchdog.guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常进度刷新 → 不触发停滞，返回委托结果', async () => {
    const watchdog = new StallWatchdog({ stallMs: 1_000, maxAttempts: 2 });
    const dispatch = vi.fn(async (_signal: AbortSignal, report: (e: WatchdogEvent) => void) => {
      report({ type: 'progress' });
      return 'done';
    });

    const promise = watchdog.guard({ dispatch, label: 'sub-agent' });
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(promise).resolves.toBe('done');
    expect(dispatch).toHaveBeenCalledTimes(1); // 无重试
  });

  it('无进展超时 → abort 当前尝试（signal.aborted）→ 重试成功', async () => {
    // 该用例用真实时间（嵌套 fake timers 调度易超时）：stallMs=50ms + 200ms 挂起
    vi.useRealTimers();
    const watchdog = new StallWatchdog({ stallMs: 50, maxAttempts: 2 });
    let attempt = 0;
    const dispatch = vi.fn(async (signal: AbortSignal) => {
      attempt += 1;
      if (attempt > 1) return 'ok'; // 重试尝试：直接成功
      // 第 1 次尝试：挂起远超 stallMs（50ms 后应被 abort，但 dispatch 自身不感知）
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      expect(signal.aborted).toBe(true); // 停滞 abort 已生效
      throw new Error('stalled-abort');
    });

    const result = await watchdog.guard({ dispatch, label: 'sub-agent' });

    expect(result).toBe('ok');
    expect(dispatch).toHaveBeenCalledTimes(2); // 停滞触发重试
  });

  it('停滞重试耗尽 → 抛「停滞重试耗尽」错误', async () => {
    const watchdog = new StallWatchdog({ stallMs: 1_000, maxAttempts: 2 });
    const dispatch = vi.fn(async () => {
      throw new Error('no-progress-fail');
    });

    await expect(watchdog.guard({ dispatch, label: 'sub-agent' })).rejects.toThrow('停滞重试耗尽');
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('tool-start 暂停计时：长跑工具不误判', async () => {
    const watchdog = new StallWatchdog({ stallMs: 1_000, maxAttempts: 2 });
    const dispatch = vi.fn(async (_signal: AbortSignal, report: (e: WatchdogEvent) => void) => {
      report({ type: 'tool-start' }); // 工具执行中：暂停计时
      await new Promise<void>((resolve) => setTimeout(resolve, 5_000)); // 长跑工具
      report({ type: 'tool-end' });
      return 'tool-done';
    });

    const promise = watchdog.guard({ dispatch, label: 'sub-agent' });
    // 工具飞行中推进远超 stallMs：不应触发停滞
    await vi.advanceTimersByTimeAsync(5_000);

    await expect(promise).resolves.toBe('tool-done');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('父取消 → 立即抛且不重试', async () => {
    const watchdog = new StallWatchdog({ stallMs: 1_000, maxAttempts: 3 });
    const controller = new AbortController();
    controller.abort(); // 父信号已取消

    const dispatch = vi.fn(async () => 'never');
    await expect(
      watchdog.guard({ dispatch, label: 'sub-agent', signal: controller.signal }),
    ).rejects.toThrow('父信号取消');
    expect(dispatch).not.toHaveBeenCalled(); // 取消后不委派
  });
});
