// src/renderer/lib/dialog-actions.test.ts
// Native dialog IPC bridge: no-bridge cancel / success / unwrap failure

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { pickDirectory, pickFiles } from './dialog-actions';
import { ipcErr, ipcOk } from './ipc-factories';

function mockDialogApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['dialog'] = impl;
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('dialog-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('pickFiles', () => {
    it('bridge success returns selected paths', async () => {
      mockDialogApi({
        pickFiles: vi.fn(async () => ipcOk({ canceled: false, paths: ['/a.txt', '/b.txt'] })),
      });
      await expect(pickFiles({ multiple: true })).resolves.toEqual({
        canceled: false,
        paths: ['/a.txt', '/b.txt'],
      });
    });

    it('omits multiple when not provided (exactOptionalPropertyTypes)', async () => {
      const pickFilesMock = vi.fn(async () => ipcOk({ canceled: true, paths: [] }));
      mockDialogApi({ pickFiles: pickFilesMock });
      await pickFiles();
      expect(pickFilesMock).toHaveBeenCalledWith({});
    });

    it('forwards multiple when provided', async () => {
      const pickFilesMock = vi.fn(async () => ipcOk({ canceled: true, paths: [] }));
      mockDialogApi({ pickFiles: pickFilesMock });
      await pickFiles({ multiple: false });
      expect(pickFilesMock).toHaveBeenCalledWith({ multiple: false });
    });

    it('no bridge returns canceled', async () => {
      removeBridge();
      await expect(pickFiles()).resolves.toEqual({ canceled: true });
    });

    it('IPC error response throws [CODE]', async () => {
      mockDialogApi({ pickFiles: vi.fn(async () => ipcErr('DIALOG_FAILED', 'boom')) });
      await expect(pickFiles()).rejects.toThrow(/\[DIALOG_FAILED\]/);
    });
  });

  describe('pickDirectory', () => {
    it('bridge success returns selected directory', async () => {
      mockDialogApi({
        pickDirectory: vi.fn(async () => ipcOk({ canceled: false, path: '/proj' })),
      });
      await expect(pickDirectory()).resolves.toEqual({ canceled: false, path: '/proj' });
    });

    it('no bridge returns canceled', async () => {
      removeBridge();
      await expect(pickDirectory()).resolves.toEqual({ canceled: true });
    });

    it('IPC error response throws [CODE]', async () => {
      mockDialogApi({ pickDirectory: vi.fn(async () => ipcErr('DIALOG_FAILED', 'boom')) });
      await expect(pickDirectory()).rejects.toThrow(/\[DIALOG_FAILED\]/);
    });
  });
});
