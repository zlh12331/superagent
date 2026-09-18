// src/renderer/hooks/__tests__/use-update-bridge.test.tsx
// use-update-bridge 单测：唯一订阅点（getStatus 快照 + subscribeStatus 事件）
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useUpdateStore } from '@/stores/transient/update-store';
import { useUpdateBridge } from '../use-update-bridge';

/** 构造 window.api.update mock（捕获订阅回调，供测试推送事件） */
function mockUpdateApi(overrides: Partial<Record<string, unknown>> = {}): {
  push: (payload: unknown) => void;
} {
  let subscribe: ((payload: unknown) => void) | undefined;
  window.api.update = {
    check: vi.fn(async () => ({ data: { status: 'checking' } })),
    install: vi.fn(async () => ({ data: { ok: true } })),
    cancel: vi.fn(async () => ({ data: { ok: true } })),
    getStatus: vi.fn(async () => ({ data: { snapshot: null, lastCheckAt: null } })),
    subscribeStatus: vi.fn((cb: (payload: unknown) => void) => {
      subscribe = cb;
      return () => {
        subscribe = undefined;
      };
    }),
    ...overrides,
  } as never;
  return { push: (payload) => subscribe?.(payload) };
}

describe('use-update-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateStore.setState({ status: null, fromSnapshot: false, lastCheckAt: null });
  });

  it('挂载：拉一次快照并订阅一次事件', async () => {
    mockUpdateApi();
    renderHook(() => useUpdateBridge());
    await waitFor(() => {
      expect(window.api.update.getStatus).toHaveBeenCalledOnce();
    });
    expect(window.api.update.subscribeStatus).toHaveBeenCalledOnce();
  });

  it('快照写入 store 且标记 fromSnapshot（回放不触发提示）', async () => {
    mockUpdateApi({
      getStatus: vi.fn(async () => ({
        data: {
          snapshot: { phase: 'downloaded', version: '1.2.0' },
          lastCheckAt: 1_700_000_000_000,
        },
      })),
    });
    renderHook(() => useUpdateBridge());

    await waitFor(() => {
      expect(useUpdateStore.getState().status).toEqual({
        phase: 'downloaded',
        version: '1.2.0',
      });
    });
    expect(useUpdateStore.getState().fromSnapshot).toBe(true);
    expect(useUpdateStore.getState().lastCheckAt).toBe(1_700_000_000_000);
  });

  it('事件推送写入 store 并清除 fromSnapshot（实时状态）', async () => {
    const api = mockUpdateApi();
    renderHook(() => useUpdateBridge());
    await waitFor(() => {
      expect(window.api.update.subscribeStatus).toHaveBeenCalledOnce();
    });

    api.push({ phase: 'downloading', progress: 30 });
    await waitFor(() => {
      expect(useUpdateStore.getState().status).toEqual({ phase: 'downloading', progress: 30 });
    });
    expect(useUpdateStore.getState().fromSnapshot).toBe(false);
  });

  it('快照读取失败：静默，不影响订阅', async () => {
    mockUpdateApi({
      getStatus: vi.fn(async () => {
        throw new Error('ipc down');
      }),
    });
    renderHook(() => useUpdateBridge());
    await waitFor(() => {
      expect(window.api.update.subscribeStatus).toHaveBeenCalledOnce();
    });
    expect(useUpdateStore.getState().status).toBeNull();
  });

  it('卸载：退订事件', async () => {
    mockUpdateApi();
    const { unmount } = renderHook(() => useUpdateBridge());
    await waitFor(() => {
      expect(window.api.update.subscribeStatus).toHaveBeenCalledOnce();
    });
    unmount();
    // unsubscribe 已调用（subscribe 返回的清理函数生效）
    expect(useUpdateStore.getState().status).toBeNull();
  });

  it('浏览器模式（无桥）：不拉快照、不订阅', () => {
    (window as unknown as { api: undefined }).api = undefined;
    renderHook(() => useUpdateBridge());
    expect(useUpdateStore.getState().status).toBeNull();
  });
});
