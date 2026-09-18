// src/renderer/hooks/__tests__/use-install-update.test.tsx
// use-install-update 单测：无回合直接安装 / 有回合先确认（确认与取消两条路径）
//
// 用真实 confirm store（而非 mock confirm 函数）：验证的是"是否真的弹了确认、
// 用户选择是否真的决定安装"，这正是该 hook 的语义所在。
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentRunStore } from '@/stores/transient/agent-run-store';
import { useConfirmDialogStore } from '@/stores/transient/confirm-dialog-store';
import { useInstallUpdate } from '../use-install-update';

const installSpy = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-update', () => ({
  useUpdate: (): { install: typeof installSpy } => ({ install: installSpy }),
}));

describe('use-install-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentRunStore.setState({ running: false });
    useConfirmDialogStore.setState({ currentRequest: null, queue: [] });
  });

  it('无运行中回合：直接安装，不弹确认', async () => {
    const { result } = renderHook(() => useInstallUpdate());
    await result.current();
    expect(installSpy).toHaveBeenCalledOnce();
    expect(useConfirmDialogStore.getState().currentRequest).toBeNull();
  });

  it('有运行中回合：先弹确认，确认后才安装', async () => {
    useAgentRunStore.setState({ running: true });
    const { result } = renderHook(() => useInstallUpdate());
    const pending = result.current();
    // 弹窗已入队（等待用户选择），此时不得安装
    expect(useConfirmDialogStore.getState().currentRequest).not.toBeNull();
    expect(installSpy).not.toHaveBeenCalled();
    useConfirmDialogStore.getState()._resolve(true);
    await pending;
    expect(installSpy).toHaveBeenCalledOnce();
  });

  it('有运行中回合：取消则完全不安装', async () => {
    useAgentRunStore.setState({ running: true });
    const { result } = renderHook(() => useInstallUpdate());
    const pending = result.current();
    useConfirmDialogStore.getState()._resolve(false);
    await pending;
    expect(installSpy).not.toHaveBeenCalled();
  });
});
