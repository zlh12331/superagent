// src/renderer/hooks/use-approval-mode.test.tsx
// Approval mode hook: read success/fallback, optimistic write/rollback, no-bridge

import { renderHook, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcErr, ipcOk } from '@/lib/ipc-factories';

import { useApprovalMode } from './use-approval-mode';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function mockSettingsApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['settings'] = {
    ...((window.api as unknown as Record<string, Record<string, unknown>>)['settings'] as Record<
      string,
      unknown
    >),
    ...impl,
  };
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('use-approval-mode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('bridge success returns mode from IPC', async () => {
    mockSettingsApi({
      getApprovalMode: vi.fn(async () => ipcOk({ mode: 'auto' })),
    });
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.mode).toBe('auto'));
  });

  it('read failure keeps default ask mode', async () => {
    mockSettingsApi({
      getApprovalMode: vi.fn(async () => ipcErr('SETTINGS_READ_FAILED', 'boom')),
    });
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.mode).toBe('ask'));
  });

  it('no bridge keeps default and setMode is local-only', async () => {
    removeBridge();
    const { result } = renderHook(() => useApprovalMode());
    expect(result.current.mode).toBe('ask');
    await result.current.setMode('auto');
    await waitFor(() => expect(result.current.mode).toBe('auto'));
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('write success updates mode', async () => {
    mockSettingsApi({
      getApprovalMode: vi.fn(async () => ipcOk({ mode: 'ask' })),
      setApprovalMode: vi.fn(async () => ipcOk({ ok: true })),
    });
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.mode).toBe('ask'));
    await result.current.setMode('auto');
    await waitFor(() => expect(result.current.mode).toBe('auto'));
  });

  it('write failure rolls back and toasts', async () => {
    mockSettingsApi({
      getApprovalMode: vi.fn(async () => ipcOk({ mode: 'ask' })),
      setApprovalMode: vi.fn(async () => ipcErr('SETTINGS_WRITE_FAILED', 'disk full')),
    });
    const { result } = renderHook(() => useApprovalMode());
    await waitFor(() => expect(result.current.mode).toBe('ask'));
    await result.current.setMode('auto');
    await waitFor(() => expect(result.current.mode).toBe('ask'));
    expect(toast.error).toHaveBeenCalled();
  });
});
