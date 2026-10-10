// browser.ts：浏览器预览域 IPC payload schema——视口矩形 / 导航 / 视口同步 / 严格模式 / 状态 / 加载失败
// 边界：预览页由主进程 WebContentsView（独立 session 分区）承载，渲染层只推视口几何；本文件只定义形状与值域，不含视图创建与安全策略实现
import { z } from 'zod';

// ────────── 调用入参（渲染层 → 主进程）：对应 request 定义见 packages/shared/src/ipc/definitions.ts ──────────

/**
 * 视口矩形（DIP；frameless 窗口下渲染层视口坐标 = 窗口 contentView 坐标，一一对应）
 *
 * 宽高必须为正：隐藏是独立语义（rect=null / visible=false），不存在用「零矩形」代替的写法。
 */
export const BrowserRectSchema = z.object({
  x: z.number().min(0),
  y: z.number().min(0),
  width: z.number().positive(),
  height: z.number().positive(),
});

/** 视口矩形 */
export type BrowserRect = z.infer<typeof BrowserRectSchema>;

/**
 * browser:navigate 请求
 *
 * 仅 http/https（file:// 等本地协议禁止经 IPC 加载）；
 * 调用即返回、不 await 加载完成——加载失败经 browser:event:loadFailed 推送，不体现为本请求的错误响应。
 */
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
  /** true = 禁用预览页 JS（严格模式）；切换会销毁并重建视图，当前页面按 URL 重新加载 */
  strictSandbox: z.boolean(),
});

/** browser:configure 请求 */
export type BrowserConfigureReq = z.infer<typeof BrowserConfigureReqSchema>;

// ────────── 回调负载（主进程 → 渲染层）：getState 响应与 browser:event:* 推送共用同一形状 ──────────

/** browser:getState 响应 / browser:event:state 推送负载（挂载时先取一次快照对齐初值，随后依赖推送增量更新） */
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

/**
 * browser:event:loadFailed 推送负载（主框架加载失败的原始 Chromium 信息）
 *
 * 仅主框架失败上报，子框架失败不推送（故负载内无 frame 标识）。
 */
export const BrowserLoadFailedPayloadSchema = z.object({
  /** 原始 Chromium 网络错误码（net::Error；渲染层只做原样展示，不映射业务错误码） */
  errorCode: z.number().int(),
  /** 与 errorCode 配套的错误描述，与 errorCode 一起直接展示 */
  errorDescription: z.string(),
  /** 加载失败的主框架地址（Electron 回调的 validatedUrl 原样透传） */
  url: z.string(),
});

/** 主框架加载失败负载 */
export type BrowserLoadFailedPayload = z.infer<typeof BrowserLoadFailedPayloadSchema>;
