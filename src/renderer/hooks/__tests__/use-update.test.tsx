// src/renderer/hooks/__tests__/use-update.test.tsx
// use-update 单元测试：订阅状态事件 / 手动检查 / 安装重启
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdate } from '../use-update';

/** 构造 window.api.update mock（返回 shape 由测试覆盖） */
function mockUpdateApi(overrides: Partial<Record<string, unknown>> = {}): void {
  window.api.update = {
    check: vi.fn(async () => ({ data: { status: 'checking' } })),
    install: vi.fn(async () => ({ data: { ok: true } })),
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

  it('收到状态推送后更新 state', () => {
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
