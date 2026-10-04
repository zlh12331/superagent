// src/main/infra/ai/agent-runtime/abort-utils.test.ts
// 中断信号工具单测：组合信号 + 可清理超时信号
//
// 接线背景：生产调用方为 turn-assembly（主回合：用户中断 + 模型级超时合并）
// 与 llm-client runSideQuery（side query：用户信号 + 模型级超时合并，有全局
// 默认兜底）。本组用例守住两件事：组合语义（任一触发即中断、预置 abort 也
// 生效）与定时器清理（clear 后不再触发，防定时器堆积）。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { combineAbortSignals, createTimeoutSignal } from './abort-utils';

describe('combineAbortSignals（组合多个中断信号）', () => {
  it('全 undefined 返回 undefined（不传 abortSignal）', () => {
    expect(combineAbortSignals([undefined, undefined])).toBeUndefined();
    expect(combineAbortSignals([])).toBeUndefined();
  });

  it('单信号原样返回（不包装）', () => {
    const signal = new AbortController().signal;
    expect(combineAbortSignals([signal])).toBe(signal);
    expect(combineAbortSignals([undefined, signal])).toBe(signal);
  });

  it('多信号：任一触发即 abort', () => {
    const user = new AbortController();
    const timeout = new AbortController();
    const combined = combineAbortSignals([user.signal, timeout.signal]) as AbortSignal;
    expect(combined.aborted).toBe(false);
    timeout.abort();
    expect(combined.aborted).toBe(true);
  });

  it('多信号：任一预置已 abort 也生效', () => {
    const user = new AbortController();
    user.abort();
    const combined = combineAbortSignals([
      user.signal,
      new AbortController().signal,
    ]) as AbortSignal;
    expect(combined.aborted).toBe(true);
  });
});

describe('createTimeoutSignal（可清理超时信号）', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('超时后 trigger abort', async () => {
    vi.useFakeTimers();
    const { signal, clear } = createTimeoutSignal(500);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    clear();
  });

  it('clear 后定时器取消，不再触发 abort（防定时器堆积）', async () => {
    vi.useFakeTimers();
    const { signal, clear } = createTimeoutSignal(1_000);
    clear();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(signal.aborted).toBe(false);
  });

  it('abort 后 clear 幂等（不抛错）', async () => {
    vi.useFakeTimers();
    const { signal, clear } = createTimeoutSignal(100);
    await vi.advanceTimersByTimeAsync(200);
    expect(signal.aborted).toBe(true);
    expect(() => clear()).not.toThrow();
  });
});
