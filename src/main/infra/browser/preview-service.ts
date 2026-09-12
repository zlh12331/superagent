// src/main/infra/browser/preview-service.ts
// 浏览器预览服务：主进程 WebContentsView 承载右面板「浏览器」tab 的页面预览
// ──────────────────────────────────────────────────────────────
// 为什么不用渲染层 iframe（v1 方案）：
// - 主进程对 defaultSession 统一注入 CSP/X-Frame-Options（src/main/index.ts +
//   src/main/security/csp.ts），onHeadersReceived 对会话内所有响应生效：
//   ① CSP 无 frame-src → 回退 default-src 'self'，跨源 iframe 被嵌侧拦截；
//   ② X-Frame-Options 被注入到远端响应本身（DENY/SAMEORIGIN），远端文档拒绝被嵌；
//   ③ 注入的严格 CSP 污染远端文档（script-src/connect-src 全被限死）。
//   三层叠加 ⇒ v1 在生产环境加载不了任何真实网页（jsdom 测试测不出）。
// - v2：WebContentsView + 独立内存 session 分区（'browser-preview'），不在
//   defaultSession 注入作用域内；sandbox/contextIsolation 开齐，权限/下载/弹窗全拒。
//
// 职责边界（与渲染层分工）：
// - 渲染层：工具栏 UI、地址/历史展示状态、占位区测量 + 设备预设/缩放几何计算
//   （browser-geometry.ts）→ browser:setViewport 推送矩形/缩放/可见性
// - 本服务：视图生命周期（懒创建/保活/销毁）、setBounds/setZoomFactor 落地、
//   webContents 事件收敛为 browser:event:state / browser:event:loadFailed 广播
//
// 页面保活策略：切 tab/折叠面板只 setVisible(false)，不销毁视图——切回时页面
// 状态（滚动/表单/SPA 路由）原样保留；销毁仅发生在严格模式切换重建与退出清理。
// ──────────────────────────────────────────────────────────────

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

/** 预览专用 session 分区（无 persist: 前缀 = 内存态，cookie/缓存不落盘、重启即清） */
const PREVIEW_PARTITION = 'browser-preview';

const STATE_EVENT = IPC_DEFINITIONS.browser.subscribeState;
const LOAD_FAILED_EVENT = IPC_DEFINITIONS.browser.subscribeLoadFailed;

/**
 * 浏览器预览服务接口（服务容器注入用）
 */
// biome-ignore lint/style/useNamingConvention: I 前缀接口遵循项目惯例（IUpdateService 等）
export interface IBrowserPreviewService {
  /** 加载 URL（仅 http/https；不 await 页面加载，失败走 loadFailed 事件推送） */
  navigate(input: BrowserNavigateReq): Promise<{ ok: boolean }>;
  /** 历史后退（无视图时幂等 no-op） */
  back(): { ok: boolean };
  /** 历史前进（无视图时幂等 no-op） */
  forward(): { ok: boolean };
  /** 重新加载（无视图时幂等 no-op） */
  reload(): { ok: boolean };
  /** 同步视口几何（rect=null 或 visible=false 仅隐藏，页面保活） */
  setViewport(input: BrowserSetViewportReq): { ok: boolean };
  /** 严格模式切换（禁用预览页 JS）；与当前值不同时销毁重建视图并回放当前 URL */
  configure(input: BrowserConfigureReq): { ok: boolean };
  /** 读取当前预览状态（地址栏/导航按钮的数据源） */
  getState(): BrowserState;
  /** 销毁视图（退出清理；窗口已销毁时安全跳过） */
  dispose(): void;
}

/** 依赖注入（测试注入 fake 视图工厂与广播捕获） */
export interface BrowserPreviewServiceDeps {
  /** 取当前主窗口（全部已销毁时返回 null） */
  readonly getWindow: () => BrowserWindow | null;
  /** 视图工厂（默认真实 WebContentsView；测试注入 fake） */
  readonly createView?: (options: { readonly javascript: boolean }) => WebContentsView;
  /** 事件广播（默认遍历所有窗口 emitEvent；测试注入捕获数组） */
  readonly broadcast?: (channel: string, payload: unknown) => void;
}

/** 预览分区 session 已配置标记（fromPartition 返回单例，handlers 仅需挂一次） */
let previewSessionConfigured = false;

/** 配置预览分区 session（幂等） */
function ensurePreviewSession(): void {
  if (previewSessionConfigured) return;
  const ses = session.fromPartition(PREVIEW_PARTITION);
  // 权限（摄像头/定位/通知/剪贴板读取等）一律拒绝：预览 pane 无需任何特权 API
  ses.setPermissionCheckHandler(() => false);
  // 下载一律取消：预览 pane 不承担下载管理
  ses.on('will-download', (event) => {
    event.preventDefault();
  });
  previewSessionConfigured = true;
}

/** 默认视图工厂：真实 WebContentsView（独立分区 + 沙箱安全基线） */
function createNativeView(options: { readonly javascript: boolean }): WebContentsView {
  ensurePreviewSession();
  return new WebContentsView({
    webPreferences: {
      partition: PREVIEW_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // 严格沙箱：预览页 JS 整体禁用（远端代码无法运行；代价：SPA 渲染为静态骨架）
      ...(options.javascript ? {} : { javascript: false }),
    },
  });
}

/** 默认广播：遍历所有窗口推送（emitEvent 内置 isDestroyed 守卫 + dev 契约校验） */
function defaultBroadcast(channel: string, payload: unknown): void {
  const def = channel === LOAD_FAILED_EVENT.channel ? LOAD_FAILED_EVENT : STATE_EVENT;
  for (const win of BrowserWindow.getAllWindows()) {
    emitEvent(win.webContents, def, payload);
  }
}

/**
 * 浏览器预览服务
 *
 * @example
 * ```ts
 * const svc = new BrowserPreviewService({ getWindow: () => BrowserWindow.getAllWindows()[0] });
 * await svc.navigate({ url: 'https://example.com' });
 * svc.setViewport({ rect: { x: 800, y: 52, width: 400, height: 600 }, visible: true, zoomFactor: 1 });
 * ```
 */
export class BrowserPreviewService implements IBrowserPreviewService {
  private view: WebContentsView | null = null;
  private strictSandbox = false;
  /** 最近一次视口几何（configure 重建后回放用） */
  private lastRect: BrowserSetViewportReq['rect'] = null;
  private lastZoomFactor = 1;
  private lastVisible = false;

  constructor(private readonly deps: BrowserPreviewServiceDeps) {}

  /** @inheritDoc */
  async navigate(input: BrowserNavigateReq): Promise<{ ok: boolean }> {
    // 双保险：定义表 zod 已拦一次；服务层自校验防绕过（直接调用服务的方法）
    if (!/^https?:\/\//i.test(input.url)) {
      throw new Error(`浏览器预览仅支持 http/https 地址：${input.url}`);
    }
    const view = this.ensureView();
    if (view === null) {
      return { ok: false };
    }
    // 不 await：慢站点不应阻塞 IPC 响应；主框架失败由 did-fail-load 推送
    void view.webContents.loadURL(input.url).catch(() => {});
    return { ok: true };
  }

  /** @inheritDoc */
  back(): { ok: boolean } {
    if (this.view !== null) {
      this.view.webContents.navigationHistory.goBack();
    }
    return { ok: true };
  }

  /** @inheritDoc */
  forward(): { ok: boolean } {
    if (this.view !== null) {
      this.view.webContents.navigationHistory.goForward();
    }
    return { ok: true };
  }

  /** @inheritDoc */
  reload(): { ok: boolean } {
    if (this.view !== null) {
      this.view.webContents.reload();
    }
    return { ok: true };
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  configure(input: BrowserConfigureReq): { ok: boolean } {
    if (input.strictSandbox === this.strictSandbox) {
      return { ok: true };
    }
    this.strictSandbox = input.strictSandbox;
    const currentUrl = this.view?.webContents.getURL() ?? null;
    this.destroyView();
    // 重建后回放几何与 URL：调用方（设置页）无需感知视图重建
    const view = this.ensureView();
    if (view !== null && currentUrl !== null && currentUrl !== '') {
      void view.webContents.loadURL(currentUrl).catch(() => {});
    }
    this.applyViewport();
    return { ok: true };
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  dispose(): void {
    this.destroyView();
  }

  /** 懒创建并附着视图；无可用窗口时返回 null（调用方按 no-op 处理） */
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

  /** webContents 事件收敛：导航/加载/标题 → state 广播；主框架失败 → loadFailed 广播 */
  private wireWebContents(wc: WebContents): void {
    // 预览页内 window.open/target=_blank：拒绝二级窗口，http(s) 转交系统浏览器
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
      // 子框架失败（广告/统计脚本）不推送给用户
      if (!isMainFrame) return;
      this.broadcast(LOAD_FAILED_EVENT.channel, {
        errorCode,
        errorDescription,
        url: validatedUrl,
      });
    });
  }

  /** 落地最近一次视口几何（bounds/zoom/可见性） */
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

  /** 销毁视图（窗口已销毁时跳过 detach；close 默认不等 beforeunload，立即销毁） */
  private destroyView(): void {
    const view = this.view;
    if (view === null) return;
    const win = this.deps.getWindow();
    if (win !== null && !win.isDestroyed()) {
      win.contentView.removeChildView(view);
    }
    if (!view.webContents.isDestroyed()) {
      view.webContents.close();
    }
    this.view = null;
  }

  /** 广播出口（测试可注入捕获） */
  private broadcast(channel: string, payload: unknown): void {
    const broadcast = this.deps.broadcast ?? defaultBroadcast;
    broadcast(channel, payload);
  }
}
