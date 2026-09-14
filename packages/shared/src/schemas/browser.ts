// packages/shared/src/schemas/browser.ts
// 浏览器预览域 payload（WebContentsView 进程外预览）
// ──────────────────────────────────────────────────────────────
// 背景：Browser 面板 v1 用渲染层 iframe 加载外站，被主进程 defaultSession
// 统一注入的安全头三层拦截（CSP 无 frame-src → 回退 default-src 'self'；
// X-Frame-Options 被注入到远端响应本身；注入的 CSP 污染远端文档），
// 生产环境无法加载任何真实网页。v2 改为主进程 WebContentsView +
// 独立内存 session 分区（'browser-preview'），彻底脱离 defaultSession
// 的 CSP/XFO 注入作用域；渲染层只保留工具栏并把视口矩形/缩放推给主进程。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/** 视口矩形（DIP；frameless 窗口下渲染层视口坐标 = 窗口 contentView 坐标，一一对应） */
export const BrowserRectSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** 视口矩形 */
export type BrowserRect = z.infer<typeof BrowserRectSchema>;

/** browser:navigate 请求（仅 http/https；file:// 等本地协议禁止经 IPC 加载） */
export const BrowserNavigateReqSchema = z.object({
  url: z
    .string()
    .min(1, 'URL 不能为空')
    .refine((value) => /^https?:\/\//i.test(value), '仅支持 http/https 地址'),
});

/** browser:navigate 请求 */
export type BrowserNavigateReq = z.infer<typeof BrowserNavigateReqSchema>;

/** browser:setViewport 请求：rect=null 或 visible=false 表示隐藏（页面保活不销毁） */
export const BrowserSetViewportReqSchema = z.object({
  rect: BrowserRectSchema.nullable(),
  visible: z.boolean(),
  /** 页面缩放系数（渲染层缩放档位百分比 / 100，范围 0.25–4 与 Chromium 一致） */
  zoomFactor: z.number().min(0.25).max(4),
});

/** browser:setViewport 请求 */
export type BrowserSetViewportReq = z.infer<typeof BrowserSetViewportReqSchema>;

/** browser:configure 请求：严格模式（禁用预览页 JS）切换；与当前值不同时重建视图 */
export const BrowserConfigureReqSchema = z.object({
  strictSandbox: z.boolean(),
});

/** browser:configure 请求 */
export type BrowserConfigureReq = z.infer<typeof BrowserConfigureReqSchema>;

/** browser:getState 响应 / browser:event:state 推送负载 */
export const BrowserStateSchema = z.object({
  /** 当前主框架 URL（未创建视图时 null） */
  url: z.string().nullable(),
  /** 页面标题（未创建视图时 null） */
  title: z.string().nullable(),
  isLoading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
});

/** 浏览器预览状态 */
export type BrowserState = z.infer<typeof BrowserStateSchema>;

/** browser:event:loadFailed 推送负载（主框架加载失败的原始 Chromium 错误码） */
export const BrowserLoadFailedPayloadSchema = z.object({
  errorCode: z.number().int(),
  errorDescription: z.string(),
  url: z.string(),
});

/** 主框架加载失败负载 */
export type BrowserLoadFailedPayload = z.infer<typeof BrowserLoadFailedPayloadSchema>;
