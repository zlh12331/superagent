// src/renderer/hooks/__tests__/use-update.test.tsx
// use-update 单测：读 update-store + 动作转发（订阅行为已由 use-update-bridge 负责）
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdateStore } from '@/stores/transient/update-store';
import { useUpdate } from '../use-update';

describe('use-update', () => {
  let installSpy: ReturnType<typeof vi.fn>;
  let cancelSpy: ReturnType<typeof vi.fn>;
  let checkSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    checkSpy = vi.fn(async () => ({ data: { status: 'checking' } }));
    installSpy = vi.fn(async () => ({ data: { ok: true } }));
    cancelSpy = vi.fn(async () => ({ data: { ok: true } }));
    window.api = {
      update: { check: checkSpy, install: installSpy, cancel: cancelSpy },
    } as never;
    useUpdateStore.setState({ status: null, fromSnapshot: false, lastCheckAt: null });
  });

  it('读取 store 中的状态与快照标记', () => {
    useUpdateStore.setState({
      status: { phase: 'downloaded', version: '1.2.0' },
      fromSnapshot: true,
      lastCheckAt: 1_700_000_000_000,
    });
    const { result } = renderHook(() => useUpdate());
    expect(result.current.state).toEqual({ phase: 'downloaded', version: '1.2.0' });
    expect(result.current.fromSnapshot).toBe(true);
    expect(result.current.lastCheckAt).toBe(1_700_000_000_000);
  });

  it('无状态时返回 null / false', () => {
    const { result } = renderHook(() => useUpdate());
    expect(result.current.state).toBeNull();
    expect(result.current.fromSnapshot).toBe(false);
    expect(result.current.lastCheckAt).toBeNull();
  });

  it('check：调用 update.check({ manual: true }) 并刷新上次检查时间', async () => {
    const { result } = renderHook(() => useUpdate());
    await act(async () => {
      await result.current.check();
    });
    expect(checkSpy).toHaveBeenCalledWith({ manual: true });
    expect(useUpdateStore.getState().lastCheckAt).toBeTypeOf('number');
  });

  it('cancel：调用 update.cancel', () => {
    const { result } = renderHook(() => useUpdate());
    act(() => {
      result.current.cancel();
    });
    expect(cancelSpy).toHaveBeenCalledOnce();
  });

  it('install：调用 update.install', () => {
    const { result } = renderHook(() => useUpdate());
    act(() => {
      result.current.install();
    });
    expect(installSpy).toHaveBeenCalledOnce();
  });

  it('浏览器模式（无桥）：三个动作均为 no-op，不抛错', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    const { result } = renderHook(() => useUpdate());
    await expect(result.current.check()).resolves.toBeUndefined();
    expect(() => result.current.cancel()).not.toThrow();
    expect(() => result.current.install()).not.toThrow();
    expect(checkSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(installSpy).not.toHaveBeenCalled();
  });
});
