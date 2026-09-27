// src/renderer/lib/devtools-actions.test.ts
// DevTools open IPC bridge: mode passthrough + no-bridge

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDevTools } from './devtools-actions';
import { ipcOk } from './ipc-factories';

function mockDevtoolsApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['devtools'] = impl;
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('devtools-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('bridge success returns result and forwards mode', async () => {
    const openMock = vi.fn(async () => ipcOk({ ok: true, mode: 'detach' }));
    mockDevtoolsApi({ open: openMock });
    await expect(openDevTools('detach')).resolves.toEqual({ ok: true, mode: 'detach' });
    expect(openMock).toHaveBeenCalledWith({ mode: 'detach' });
  });

  it('no bridge throws [NO_BRIDGE]', async () => {
    removeBridge();
    await expect(openDevTools('right')).rejects.toThrow(/\[NO_BRIDGE\]/);
  });
});
