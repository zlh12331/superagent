// src/renderer/hooks/__tests__/use-tool-bridge.test.tsx
// use-tool-bridge 单元测试：订阅工具调用事件（挂载注册 / 卸载清理）

import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useToolBridge } from '../use-tool-bridge';

describe('use-tool-bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('挂载时注册订阅（subscribeToolCall/subscribeToolResult）', () => {
    const subscribeToolCall = vi.fn(() => () => {});
    const subscribeToolResult = vi.fn(() => () => {});
    window.api.agent = {
      run: vi.fn(),
      stop: vi.fn(),
      approvalResponse: vi.fn(),
      subscribeStreamPart: vi.fn(() => () => {}),
      subscribeStreamEnd: vi.fn(() => () => {}),
      subscribeStreamError: vi.fn(() => () => {}),
      subscribeToolCall,
      subscribeToolResult,
      subscribeApprovalRequest: vi.fn(() => () => {}),
    } as never;

    renderHook(() => useToolBridge());
    expect(subscribeToolCall).toHaveBeenCalled();
    expect(subscribeToolResult).toHaveBeenCalled();
  });

  it('卸载时调用返回的 unsubscribe 清理监听', () => {
    const unsubscribe = vi.fn();
    window.api.agent = {
      run: vi.fn(),
      stop: vi.fn(),
      approvalResponse: vi.fn(),
      subscribeStreamPart: vi.fn(() => () => {}),
      subscribeStreamEnd: vi.fn(() => () => {}),
      subscribeStreamError: vi.fn(() => () => {}),
      subscribeToolCall: vi.fn(() => unsubscribe),
      subscribeToolResult: vi.fn(() => unsubscribe),
      subscribeApprovalRequest: vi.fn(() => () => {}),
    } as never;

    const { unmount } = renderHook(() => useToolBridge());
    unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });
});
