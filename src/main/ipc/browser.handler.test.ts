// src/main/ipc/browser.handler.test.ts
// browser.handler 单测：请求转发（fake BrowserPreviewService DI 注入）
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BrowserHandlerDeps, createBrowserHandlers } from './browser.handler';

/** 创建 fake BrowserPreviewService */
function createFakePreviewService() {
  return {
    navigate: vi.fn(async () => ({ ok: true })),
    back: vi.fn(() => ({ ok: true })),
    forward: vi.fn(() => ({ ok: true })),
    reload: vi.fn(() => ({ ok: true })),
    setViewport: vi.fn(() => ({ ok: true })),
    configure: vi.fn(() => ({ ok: true })),
    getState: vi.fn(() => ({
      url: null,
      title: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
    })),
    dispose: vi.fn(),
  } as unknown as BrowserHandlerDeps['browserPreviewService'] &
    Record<string, ReturnType<typeof vi.fn>>;
}

const EMPTY_CTX = {} as never;

describe('browser.handler', () => {
  let svc: ReturnType<typeof createFakePreviewService>;
  let handlers: ReturnType<typeof createBrowserHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    svc = createFakePreviewService();
    handlers = createBrowserHandlers({ browserPreviewService: svc });
  });

  it('navigate：转发 URL 入参', async () => {
    await handlers.navigate({ url: 'https://example.com' }, EMPTY_CTX);
    expect(svc.navigate).toHaveBeenCalledWith({ url: 'https://example.com' });
  });

  it('back/forward/reload：无参转发', async () => {
    await handlers.back(undefined, EMPTY_CTX);
    await handlers.forward(undefined, EMPTY_CTX);
    await handlers.reload(undefined, EMPTY_CTX);
    expect(svc.back).toHaveBeenCalledOnce();
    expect(svc.forward).toHaveBeenCalledOnce();
    expect(svc.reload).toHaveBeenCalledOnce();
  });

  it('setViewport：转发视口几何', async () => {
    const input = { rect: { x: 0, y: 0, width: 400, height: 300 }, visible: true, zoomFactor: 1 };
    await handlers.setViewport(input, EMPTY_CTX);
    expect(svc.setViewport).toHaveBeenCalledWith(input);
  });

  it('configure：转发严格模式开关', async () => {
    await handlers.configure({ strictSandbox: true }, EMPTY_CTX);
    expect(svc.configure).toHaveBeenCalledWith({ strictSandbox: true });
  });

  it('getState：透传预览状态', async () => {
    const result = await handlers.getState(undefined, EMPTY_CTX);
    expect(result).toEqual({
      url: null,
      title: null,
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
    });
  });
});
