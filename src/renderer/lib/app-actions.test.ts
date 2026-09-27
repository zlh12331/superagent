// src/renderer/lib/app-actions.test.ts
// App shell IPC bridge: no-bridge / success / unwrap failure

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchAppInfo, openDataDir, openExternal, quitApp } from './app-actions';
import { ipcErr, ipcOk } from './ipc-factories';

function mockAppApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['app'] = {
    ...((window.api as unknown as Record<string, Record<string, unknown>>)['app'] as Record<
      string,
      unknown
    >),
    ...impl,
  };
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('app-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('fetchAppInfo', () => {
    it('bridge success returns app info', async () => {
      const info = {
        version: '1.2.3',
        platform: 'win32',
        userDataPath: 'C:/Users/x/AppData',
        isPackaged: true,
      };
      mockAppApi({ getInfo: vi.fn(async () => ipcOk(info)) });
      await expect(fetchAppInfo()).resolves.toEqual(info);
    });

    it('no bridge throws [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(fetchAppInfo()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('IPC error response throws [CODE]', async () => {
      mockAppApi({ getInfo: vi.fn(async () => ipcErr('DB_ERROR', 'boom')) });
      await expect(fetchAppInfo()).rejects.toThrow(/\[DB_ERROR\]/);
    });
  });

  describe('openExternal', () => {
    it('bridge success returns true', async () => {
      const openMock = vi.fn(async () => ipcOk({ ok: true }));
      mockAppApi({ openExternal: openMock });
      await expect(openExternal('https://example.com')).resolves.toBe(true);
      expect(openMock).toHaveBeenCalledWith({ url: 'https://example.com' });
    });

    it('no bridge returns false', async () => {
      removeBridge();
      await expect(openExternal('https://example.com')).resolves.toBe(false);
    });

    it('IPC error response throws [CODE]', async () => {
      mockAppApi({ openExternal: vi.fn(async () => ipcErr('OPEN_FAILED', 'blocked')) });
      await expect(openExternal('https://example.com')).rejects.toThrow(/\[OPEN_FAILED\]/);
    });
  });

  describe('openDataDir', () => {
    it('bridge success returns true', async () => {
      mockAppApi({ openDataDir: vi.fn(async () => ipcOk({ ok: true })) });
      await expect(openDataDir()).resolves.toBe(true);
    });

    it('no bridge returns false', async () => {
      removeBridge();
      await expect(openDataDir()).resolves.toBe(false);
    });
  });

  describe('quitApp', () => {
    it('bridge returns true and invokes quit', () => {
      const quitMock = vi.fn(async () => ipcOk({ ok: true }));
      mockAppApi({ quit: quitMock });
      expect(quitApp()).toBe(true);
      expect(quitMock).toHaveBeenCalledTimes(1);
    });

    it('no bridge returns false', () => {
      removeBridge();
      expect(quitApp()).toBe(false);
    });
  });
});
