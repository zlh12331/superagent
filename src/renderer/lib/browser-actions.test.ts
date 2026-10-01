// src/renderer/lib/browser-actions.test.ts
// Browser preview IPC bridge: nav / navigate / state / subscribe + no-bridge

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  browserBack,
  browserForward,
  browserNavigate,
  browserReload,
  getBrowserState,
  subscribeBrowserLoadFailed,
  subscribeBrowserState,
} from './browser-actions';
import { ipcErr, ipcOk } from './ipc-factories';

function mockBrowserApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['browser'] = impl;
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('browser-actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('back / forward / reload', () => {
    it('bridge resolves IpcResponse', async () => {
      mockBrowserApi({
        back: vi.fn(async () => ipcOk({ ok: true })),
        forward: vi.fn(async () => ipcOk({ ok: true })),
        reload: vi.fn(async () => ipcOk({ ok: true })),
      });
      await expect(browserBack()).resolves.toEqual({ data: { ok: true } });
      await expect(browserForward()).resolves.toEqual({ data: { ok: true } });
      await expect(browserReload()).resolves.toEqual({ data: { ok: true } });
    });

    it('no bridge rejects [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(browserBack()).rejects.toThrow(/\[NO_BRIDGE\]/);
      await expect(browserForward()).rejects.toThrow(/\[NO_BRIDGE\]/);
      await expect(browserReload()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });
  });

  describe('browserNavigate', () => {
    it('bridge success unwraps', async () => {
      const navMock = vi.fn(async () => ipcOk({ ok: true }));
      mockBrowserApi({ navigate: navMock });
      await expect(browserNavigate('https://example.com')).resolves.toBeUndefined();
      expect(navMock).toHaveBeenCalledWith({ url: 'https://example.com' });
    });

    it('no bridge throws [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(browserNavigate('https://example.com')).rejects.toThrow(/\[NO_BRIDGE\]/);
    });

    it('IPC error response throws [CODE]', async () => {
      mockBrowserApi({ navigate: vi.fn(async () => ipcErr('NAV_FAILED', 'bad url')) });
      await expect(browserNavigate('https://example.com')).rejects.toThrow(/\[NAV_FAILED\]/);
    });
  });

  describe('getBrowserState', () => {
    it('bridge success returns snapshot', async () => {
      const state = {
        url: 'https://example.com',
        title: 'Example',
        isLoading: false,
        canGoBack: true,
        canGoForward: false,
      };
      mockBrowserApi({ getState: vi.fn(async () => ipcOk(state)) });
      await expect(getBrowserState()).resolves.toEqual(state);
    });

    it('no bridge throws [NO_BRIDGE]', async () => {
      removeBridge();
      await expect(getBrowserState()).rejects.toThrow(/\[NO_BRIDGE\]/);
    });
  });

  describe('subscribeBrowserState / subscribeBrowserLoadFailed', () => {
    it('bridge registers handlers and returns working unsubscribe', () => {
      const unsubState = vi.fn();
      const unsubFailed = vi.fn();
      mockBrowserApi({
        subscribeState: vi.fn(() => unsubState),
        subscribeLoadFailed: vi.fn(() => unsubFailed),
      });
      const offState = subscribeBrowserState(() => {});
      const offFailed = subscribeBrowserLoadFailed(() => {});
      offState();
      offFailed();
      expect(unsubState).toHaveBeenCalledTimes(1);
      expect(unsubFailed).toHaveBeenCalledTimes(1);
    });

    it('no bridge returns callable no-op unsubscribe', () => {
      removeBridge();
      const offState = subscribeBrowserState(() => {});
      const offFailed = subscribeBrowserLoadFailed(() => {});
      expect(() => offState()).not.toThrow();
      expect(() => offFailed()).not.toThrow();
    });
  });
});
