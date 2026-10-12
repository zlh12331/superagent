import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentRunStore } from '@/stores/transient/agent-run-store';
import { useConfirmDialogStore } from '@/stores/transient/confirm-dialog-store';
import { useInstallUpdate } from './use-install-update';

const installSpy = vi.fn(async () => ({ data: { ok: true } }));

describe('use-install-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentRunStore.setState({ running: false });
    useConfirmDialogStore.setState({ currentRequest: null, queue: [] });
    window.api = { update: { install: installSpy } } as never;
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

  it('浏览器模式（无桥）：不抛错、不安装', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    const { result } = renderHook(() => useInstallUpdate());
    await expect(result.current()).resolves.toBeUndefined();
    expect(installSpy).not.toHaveBeenCalled();
  });
});
