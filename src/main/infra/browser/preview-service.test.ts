import { beforeEach, describe, expect, it, vi } from 'vitest';

const { openExternalMock } = vi.hoisted(() => ({ openExternalMock: vi.fn() }));

vi.mock('electron', () => ({
  ['BrowserWindow']: { getAllWindows: vi.fn(() => []) },
  ['WebContentsView']: vi.fn(),
  ['session']: { fromPartition: vi.fn() },
  ['shell']: { openExternal: openExternalMock },
}));

import type { BrowserWindow, WebContentsView } from 'electron';
import { BrowserPreviewService } from './preview-service';

function createFakeWin(): BrowserWindow & {
  added: unknown[];
  removed: unknown[];
} {
  const added: unknown[] = [];
  const removed: unknown[] = [];
  return {
    contentView: {
      addChildView: (v: unknown) => {
        added.push(v);
      },
      removeChildView: (v: unknown) => {
        removed.push(v);
      },
    },
    isDestroyed: () => false,
    added,
    removed,
  } as unknown as BrowserWindow & { added: unknown[]; removed: unknown[] };
}

interface FakeWebContents {
  handlers: Map<string, (...args: unknown[]) => void>;
  emit(event: string, ...args: unknown[]): void;
  url: string;
  title: string;
  loading: boolean;
  canBack: boolean;
  canForward: boolean;
  zoom: number;
  bounds: unknown;
  visible: boolean;
  destroyed: boolean;
}

function createFakeViewFactory() {
  const created: { javascript: boolean; wc: FakeWebContents }[] = [];
  const factory = (options: { readonly javascript: boolean }): WebContentsView => {
    const wc: FakeWebContents = {
      handlers: new Map(),
      emit(event, ...args) {
        wc.handlers.get(event)?.(...args);
      },
      url: '',
      title: '',
      loading: false,
      canBack: false,
      canForward: false,
      zoom: 1,
      bounds: null,
      visible: false,
      destroyed: false,
    };
    const view = {
      webContents: {
        loadURL: vi.fn(async (url: string) => {
          wc.url = url;
        }),
        getURL: () => wc.url,
        getTitle: () => wc.title,
        isLoading: () => wc.loading,
        isDestroyed: () => wc.destroyed,
        close: vi.fn(() => {
          wc.destroyed = true;
        }),
        setZoomFactor: (f: number) => {
          wc.zoom = f;
        },
        reload: vi.fn(),
        navigationHistory: {
          canGoBack: () => wc.canBack,
          canGoForward: () => wc.canForward,
          goBack: vi.fn(),
          goForward: vi.fn(),
        },
        setWindowOpenHandler: vi.fn(
          (handler: (details: { url: string }) => { action: 'deny' | 'allow' }) => {
            wc.handlers.set('__windowOpen', handler as unknown as (...args: unknown[]) => void);
          },
        ),
        on: (event: string, listener: (...args: unknown[]) => void) => {
          wc.handlers.set(event, listener);
        },
      },
      setBounds: (bounds: unknown) => {
        wc.bounds = bounds;
      },
      setVisible: (visible: boolean) => {
        wc.visible = visible;
      },
    };
    created.push({ javascript: options.javascript, wc });
    return view as unknown as WebContentsView;
  };
  return { factory, created };
}

type Broadcast = [channel: string, payload: unknown];

function createHarness() {
  const win = createFakeWin();
  const { factory, created } = createFakeViewFactory();
  const broadcasts: Broadcast[] = [];
  const svc = new BrowserPreviewService({
    getWindow: () => win,
    createView: factory,
    broadcast: (channel, payload) => {
      broadcasts.push([channel, payload]);
    },
  });
  return { svc, win, created, broadcasts };
}

const RECT = { x: 800, y: 52, width: 400, height: 600 };

function mustWc(h: ReturnType<typeof createHarness>): FakeWebContents {
  const wc = h.created[0]?.wc;
  if (wc === undefined) {
    throw new Error('预期视图已创建，实际未创建');
  }
  return wc;
}

describe('BrowserPreviewService', () => {
  let h: ReturnType<typeof createHarness>;

  beforeEach(() => {
    vi.clearAllMocks();
    h = createHarness();
  });

  describe('navigate', () => {
    it('懒创建视图：附着窗口 + loadURL（不 await 页面加载）', async () => {
      const res = await h.svc.navigate({ url: 'https://example.com' });
      expect(res).toEqual({ ok: true });
      expect(h.created).toHaveLength(1);
      expect(h.created[0]?.javascript).toBe(true);
      expect(h.win.added).toHaveLength(1);
      expect(h.created[0]?.wc.url).toBe('https://example.com');
    });

    it('重复导航复用已有视图', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      await h.svc.navigate({ url: 'https://b.com' });
      expect(h.created).toHaveLength(1);
      expect(h.created[0]?.wc.url).toBe('https://b.com');
    });

    it('非 http/https 拒绝（防 file:// 经 IPC 加载）', async () => {
      await expect(h.svc.navigate({ url: 'file:///C:/Windows/system32' })).rejects.toThrow(
        /http\/https/,
      );
      expect(h.created).toHaveLength(0);
    });

    it('无可用窗口：ok=false 且不创建视图', async () => {
      const svc = new BrowserPreviewService({
        getWindow: () => null,
        createView: createFakeViewFactory().factory,
        broadcast: () => {},
      });
      const res = await svc.navigate({ url: 'https://example.com' });
      expect(res).toEqual({ ok: false });
    });
  });

  describe('setViewport', () => {
    it('bounds/zoom/可见性落地', async () => {
      await h.svc.setViewport({ rect: RECT, visible: true, zoomFactor: 1.5 });
      const wc = h.created[0]?.wc;
      expect(wc?.bounds).toEqual(RECT);
      expect(wc?.zoom).toBe(1.5);
      expect(wc?.visible).toBe(true);
    });

    it('rect=null 仅隐藏不销毁（页面保活）', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      await h.svc.setViewport({ rect: null, visible: false, zoomFactor: 1 });
      const wc = h.created[0]?.wc;
      expect(wc?.visible).toBe(false);
      expect(wc?.destroyed).toBe(false);
      expect(h.win.removed).toHaveLength(0);
    });
  });

  describe('back / forward / reload', () => {
    it('无视图时幂等 no-op', () => {
      expect(h.svc.back()).toEqual({ ok: true });
      expect(h.svc.forward()).toEqual({ ok: true });
      expect(h.svc.reload()).toEqual({ ok: true });
      expect(h.created).toHaveLength(0);
    });

    it('有视图时委托 navigationHistory / reload', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      const webContents = (
        h.win.added[0] as unknown as {
          webContents: {
            navigationHistory: { goBack: () => void; goForward: () => void };
            reload: () => void;
          };
        }
      ).webContents;
      h.svc.back();
      h.svc.forward();
      h.svc.reload();
      expect(vi.mocked(webContents.navigationHistory.goBack)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(webContents.navigationHistory.goForward)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(webContents.reload)).toHaveBeenCalledTimes(1);
    });
  });

  describe('configure', () => {
    it('严格模式切换：销毁重建 + 回放 URL 与几何', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      await h.svc.setViewport({ rect: RECT, visible: true, zoomFactor: 1.25 });
      const res = await h.svc.configure({ strictSandbox: true });
      expect(res).toEqual({ ok: true });
      expect(h.created).toHaveLength(2);
      expect(h.created[0]?.wc.destroyed).toBe(true);
      expect(h.created[1]?.javascript).toBe(false);
      expect(h.created[1]?.wc.url).toBe('https://a.com');
      expect(h.created[1]?.wc.bounds).toEqual(RECT);
      expect(h.created[1]?.wc.visible).toBe(true);
    });

    it('同值幂等：不重建', async () => {
      await h.svc.configure({ strictSandbox: false });
      expect(h.created).toHaveLength(0);
    });
  });

  describe('事件收敛', () => {
    it('did-navigate → state 广播（URL/导航能力）', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      const wc = mustWc(h);
      wc.canBack = true;
      wc.loading = true;
      wc.emit('did-navigate', {}, 'https://a.com/');
      const last = h.broadcasts.at(-1);
      expect(last?.[0]).toBe('browser:event:state');
      expect(last?.[1]).toEqual({
        url: 'https://a.com',
        title: null,
        isLoading: true,
        canGoBack: true,
        canGoForward: false,
      });
    });

    it('主框架加载失败 → loadFailed 广播；子框架失败不广播', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      const wc = mustWc(h);
      wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.com', false);
      expect(h.broadcasts).toHaveLength(0);
      wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://a.com', true);
      const last = h.broadcasts.at(-1);
      expect(last?.[0]).toBe('browser:event:loadFailed');
      expect(last?.[1]).toEqual({
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        url: 'https://a.com',
      });
    });

    it('预览页 window.open：拒绝弹窗，http(s) 转交系统浏览器', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      const wc = mustWc(h);
      wc.emit('__windowOpen', { url: 'https://popup.example' });
      expect(openExternalMock).toHaveBeenCalledWith('https://popup.example');
      openExternalMock.mockClear();
      wc.emit('__windowOpen', { url: 'javascript:alert(1)' });
      expect(openExternalMock).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('close + detach', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      h.svc.dispose();
      expect(h.created[0]?.wc.destroyed).toBe(true);
      expect(h.win.removed).toHaveLength(1);
    });

    it('窗口已销毁：安全跳过 detach 不抛错', async () => {
      await h.svc.navigate({ url: 'https://a.com' });
      const svc = new BrowserPreviewService({
        getWindow: () => null,
        createView: createFakeViewFactory().factory,
        broadcast: () => {},
      });
      expect(() => svc.dispose()).not.toThrow();
    });
  });
});
