// preview-service.ts：网页预览服务——WebContentsView 附着主窗承载外站，独立内存分区隔离会话
// ⚠️ 网页预览绝不能回渲染层 iframe（主进程 CSP/XFO 三层拦截）；本服务是唯一合法承载路径
import {
  type BrowserConfigureReq,
  type BrowserNavigateReq,
  type BrowserSetViewportReq,
  type BrowserState,
  IPC_DEFINITIONS,
} from '@code-agent/shared/main';
import type { WebContents } from 'electron';
import { BrowserWindow, session, shell, WebContentsView } from 'electron';
import { emitEvent } from '../../utils/emit-event';
import { logger } from '../../utils/logger';

// 独立分区：预览的 cookie/缓存与主应用 defaultSession 完全隔离（不污染登录态、不泄露存储）
const PREVIEW_PARTITION = 'browser-preview';

const STATE_EVENT = IPC_DEFINITIONS.browser.subscribeState;
const LOAD_FAILED_EVENT = IPC_DEFINITIONS.browser.subscribeLoadFailed;

/** 预览服务接口（IPC handler 直接消费） */
// biome-ignore lint/style/useNamingConvention: I 前缀接口遵循项目惯例（IUpdateService 等）
export interface IBrowserPreviewService {
  navigate(input: BrowserNavigateReq): Promise<{ ok: boolean }>;
  back(): { ok: boolean };
  forward(): { ok: boolean };
  reload(): { ok: boolean };
  setViewport(input: BrowserSetViewportReq): { ok: boolean };
  configure(input: BrowserConfigureReq): { ok: boolean };
  getState(): BrowserState;
  dispose(): void;
}

/** 依赖注入：宿主窗口探针必传；createView/broadcast 可替换（测试） */
export interface BrowserPreviewServiceDeps {
  readonly getWindow: () => BrowserWindow | null;
  readonly createView?: (options: { readonly javascript: boolean }) => WebContentsView;
  readonly broadcast?: (channel: string, payload: unknown) => void;
}

// 分区一次性配置：权限请求全拒、下载一律取消（预览不承载这两类交互）
let previewSessionConfigured = false;

function ensurePreviewSession(): void {
  if (previewSessionConfigured) return;
  const ses = session.fromPartition(PREVIEW_PARTITION);
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', (event) => {
    event.preventDefault();
  });
  previewSessionConfigured = true;
}

function createNativeView(options: { readonly javascript: boolean }): WebContentsView {
  ensurePreviewSession();
  return new WebContentsView({
    webPreferences: {
      partition: PREVIEW_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      ...(options.javascript ? {} : { javascript: false }),
    },
  });
}

function defaultBroadcast(channel: string, payload: unknown): void {
  const def = channel === LOAD_FAILED_EVENT.channel ? LOAD_FAILED_EVENT : STATE_EVENT;
  for (const win of BrowserWindow.getAllWindows()) {
    emitEvent(win.webContents, def, payload);
  }
}

/**
 * 网页预览服务：按需创建 WebContentsView 附着到主窗 contentView，随视口参数显隐/定位/缩放
 *
 * strictSandbox=true 时禁 JS（静态快照模式），切换需重建视图并恢复当前 URL
 */
export class BrowserPreviewService implements IBrowserPreviewService {
  private view: WebContentsView | null = null;
  private strictSandbox = false;
  private lastRect: BrowserSetViewportReq['rect'] = null;
  private lastZoomFactor = 1;
  private lastVisible = false;

  constructor(private readonly deps: BrowserPreviewServiceDeps) {}

  async navigate(input: BrowserNavigateReq): Promise<{ ok: boolean }> {
    // 协议白名单：file:/ftp:/自定 scheme 一律不进预览（防本地文件探测）
    if (!/^https?:\/\//i.test(input.url)) {
      throw new Error(`浏览器预览仅支持 http/https 地址：${input.url}`);
    }
    const view = this.ensureView();
    if (view === null) {
      return { ok: false };
    }
    // loadURL 失败静默：did-fail-load 事件已向渲染层推送错误态，这里吞掉未处理 rejection
    void view.webContents.loadURL(input.url).catch(() => {});
    return { ok: true };
  }

  back(): { ok: boolean } {
    if (this.view !== null) {
      this.view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  }

  forward(): { ok: boolean } {
    if (this.view !== null) {
      this.view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  }

  reload(): { ok: boolean } {
    if (this.view !== null) {
      this.view.webContents.reload();
    }
    return { ok: true };
  }

  setViewport(input: BrowserSetViewportReq): { ok: boolean } {
    this.lastRect = input.rect;
    this.lastZoomFactor = input.zoomFactor;
    this.lastVisible = input.visible && input.rect !== null;
    if (this.lastVisible) {
      const view = this.ensureView();
      if (view === null) return { ok: true };
    }
    this.applyViewport();
    return { ok: true };
  }

  configure(input: BrowserConfigureReq): { ok: boolean } {
    // strictSandbox 切换必须重建视图（webPreferences 创建后不可变）；先记 URL 再恢复
    if (input.strictSandbox === this.strictSandbox) {
      return { ok: true };
    }
    this.strictSandbox = input.strictSandbox;
    const currentUrl = this.view?.webContents.getURL() ?? null;
    this.destroyView();
    const view = this.ensureView();
    if (view !== null && currentUrl !== null && currentUrl !== '') {
      void view.webContents.loadURL(currentUrl).catch(() => {});
    }
    this.applyViewport();
    return { ok: true };
  }

  getState(): BrowserState {
    const view = this.view;
    if (view === null) {
      return { url: null, title: null, isLoading: false, canGoBack: false, canGoForward: false };
    }
    const wc = view.webContents;
    return {
      url: wc.getURL() || null,
      title: wc.getTitle() || null,
      isLoading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
    };
  }

  dispose(): void {
    this.destroyView();
  }

  private ensureView(): WebContentsView | null {
    if (this.view !== null) return this.view;
    const win = this.deps.getWindow();
    if (win === null || win.isDestroyed()) {
      logger.warn({}, '浏览器预览：无可附着窗口，忽略本次操作');
      return null;
    }
    const create = this.deps.createView ?? createNativeView;
    const view = create({ javascript: !this.strictSandbox });
    win.contentView.addChildView(view);
    this.wireWebContents(view.webContents);
    this.view = view;
    logger.info(
      { partition: PREVIEW_PARTITION, strict: this.strictSandbox },
      '浏览器预览视图已创建',
    );
    return view;
  }

  private wireWebContents(wc: WebContents): void {
    // 新开窗拒绝、外链交系统浏览器（与主窗 window-open 策略一致）
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
      return { action: 'deny' };
    });
    const emitState = (): void => {
      this.broadcast(STATE_EVENT.channel, this.getState());
    };
    wc.on('did-start-loading', emitState);
    wc.on('did-stop-loading', emitState);
    wc.on('did-navigate', emitState);
    wc.on('did-navigate-in-page', emitState);
    wc.on('page-title-updated', emitState);
    wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return; // 子资源失败属常态（图标/追踪脚本），只报主框架失败
      this.broadcast(LOAD_FAILED_EVENT.channel, {
        errorCode,
        errorDescription,
        url: validatedUrl,
      });
    });
  }

  private applyViewport(): void {
    const view = this.view;
    if (view === null) return;
    if (this.lastRect === null || !this.lastVisible) {
      view.setVisible(false);
      return;
    }
    view.webContents.setZoomFactor(this.lastZoomFactor);
    view.setBounds(this.lastRect);
    view.setVisible(true);
  }

  private destroyView(): void {
    const view = this.view;
    if (view === null) return;
    // 先从 contentView 摘除再关 webContents：直接 close 会连带窗口渲染异常
    const win = this.deps.getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.view = null;
  }

  private broadcast(channel: string, payload: unknown): void {
    const broadcast = this.deps.broadcast ?? defaultBroadcast;
    broadcast(channel, payload);
  }
}
