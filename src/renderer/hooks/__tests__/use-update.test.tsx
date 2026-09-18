// src/renderer/hooks/__tests__/use-update.test.tsx
// use-update 单元测试：订阅状态事件 / 挂载快照 / 手动检查 / 取消下载 / 安装重启
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdate } from '../use-update';

/** 构造 window.api.update mock（返回 shape 由测试覆盖） */
function mockUpdateApi(overrides: Partial<Record<string, unknown>> = {}): void {
  window.api.update = {
    check: vi.fn(async () => ({ data: { status: 'checking' } })),
    install: vi.fn(async () => ({ data: { ok: true } })),
    cancel: vi.fn(async () => ({ data: { ok: true } })),
    getStatus: vi.fn(async () => ({ data: { snapshot: null } })),
    subscribeStatus: vi.fn(() => () => {}),
    ...overrides,
  } as never;
}

describe('use-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateApi();
  });

  it('挂载时订阅状态事件（返回 unsubscribe）', () => {
    const subscribeStatus = vi.fn(() => () => {});
    mockUpdateApi({ subscribeStatus });
    const { unmount } = renderHook(() => useUpdate());
    expect(subscribeStatus).toHaveBeenCalledOnce();
    unmount();
  });

  it('收到状态推送后更新 state（fromSnapshot 为假）', () => {
    let callback: ((payload: unknown) => void) | undefined;
    mockUpdateApi({
      subscribeStatus: vi.fn((cb: (payload: unknown) => void) => {
        callback = cb;
        return () => {};
      }),
    });
    const { result } = renderHook(() => useUpdate());
    act(() => {
      callback?.({ phase: 'downloaded', version: '1.1.0' });
    });
    expect(result.current.state).toEqual({ phase: 'downloaded', version: '1.1.0' });
    expect(result.current.fromSnapshot).toBe(false);
  });

  it('挂载时拉取快照：无事件时以快照为准且标记 fromSnapshot', async () => {
    mockUpdateApi({
      getStatus: vi.fn(async () => ({
        data: { snapshot: { phase: 'downloaded', version: '1.1.0' } },
      })),
    });
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => {
      expect(result.current.state).toEqual({ phase: 'downloaded', version: '1.1.0' });
    });
    expect(result.current.fromSnapshot).toBe(true);
  });

  it('快照为空时不覆盖 state（保持 null）', async () => {
    const { result } = renderHook(() => useUpdate());
    await waitFor(() => {
      expect(window.api.update.getStatus).toHaveBeenCalledOnce();
    });
    expect(result.current.state).toBeNull();
    expect(result.current.fromSnapshot).toBe(false);
  });

  it('check：调用 update.check({ manual: true })', async () => {
    const check = vi.fn(async () => ({ data: { status: 'checking' } }));
    mockUpdateApi({ check });
    const { result } = renderHook(() => useUpdate());
    await act(async () => {
      await result.current.check();
    });
    expect(check).toHaveBeenCalledWith({ manual: true });
  });

  it('cancel：调用 update.cancel', () => {
    const cancel = vi.fn(async () => ({ data: { ok: true } }));
    mockUpdateApi({ cancel });
    const { result } = renderHook(() => useUpdate());
    act(() => {
      result.current.cancel();
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('install：调用 update.install', () => {
    const install = vi.fn(async () => ({ data: { ok: true } }));
    mockUpdateApi({ install });
    const { result } = renderHook(() => useUpdate());
    act(() => {
      result.current.install();
    });
    expect(install).toHaveBeenCalledOnce();
  });
});
