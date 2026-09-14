// src/renderer/lib/error-report.ts
// 渲染层错误上报单一出口 + 全局错误落盘（2026-09-13，Sentry 移除后引入）
// ──────────────────────────────────────────────────────────────
// - reportError：错误边界 / hook 的错误汇聚点，经 electron-log renderer
//   转发主进程落盘（main 已 log.initialize() 建立转发通道）——
//   诊断包从此包含渲染层现场（此前渲染层错误只进 Sentry，诊断包不可见）
// - initRendererErrorHandlers：window error + unhandledrejection 全局兜底，
//   替代原 @sentry/electron 的自动捕获
// 将来接任何后端（Sentry / GlitchTip / OTel exception events）只改本文件。
//
// ⚠️ electron-log/renderer 为 CJS，首次 import 需过 Vite 转换器（实测 >5s），
// 而本模块被大量组件/hook 静态导入——因此改为**惰性加载**：模块加载不付出
// 代价，仅在实际发生错误时按需引入（错误上报是低频路径）。加载完成前的
// 上报进入有界队列，加载后补记。
// ──────────────────────────────────────────────────────────────

/** electron-log renderer 模块类型（惰性加载后缓存） */
type LogModule = typeof import('electron-log/renderer');

/** 已加载的日志模块（null = 尚未加载完成） */
let logModule: LogModule | null = null;
/** 加载中标记（防重复触发 import） */
let loading: Promise<void> | null = null;
/** 加载完成前的待补记条目（有界：错误风暴时丢弃最旧，不无限占内存） */
const PENDING_LIMIT = 50;
const pending: { message: string; detail: string }[] = [];

/** 惰性加载 electron-log renderer（幂等；失败静默——上报本就 best-effort） */
function ensureLogModule(): void {
  if (logModule !== null || loading !== null) {
    return;
  }
  loading = import('electron-log/renderer')
    .then((mod) => {
      logModule = mod;
      // 补记加载期间积压的上报
      for (const item of pending) {
        mod.default.error({ message: item.message }, item.detail);
      }
      pending.length = 0;
    })
    .catch(() => {
      // 加载失败：后续上报继续走控制台兜底，不影响业务
    });
}

/** 渲染层错误上报上下文（结构化字段，随日志落盘） */
export interface RendererErrorContext {
  /** 分组/来源标签（原 Sentry tags 语义） */
  readonly tags?: Readonly<Record<string, string>>;
  /** React 组件栈（错误边界场景，帮助定位出错组件） */
  readonly componentStack?: string;
}

/**
 * 上报渲染层错误（原 Sentry.captureException 收敛点）
 */
export function reportError(error: unknown, context?: RendererErrorContext): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const meta = {
    ...(context?.tags ?? {}),
    ...(context?.componentStack !== undefined ? { componentStack: context.componentStack } : {}),
    message: '渲染层错误上报',
  };
  ensureLogModule();
  if (logModule !== null) {
    logModule.default.error(meta, detail);
    return;
  }
  // 尚未加载完成：入队待补记（超界丢最旧）
  if (pending.length >= PENDING_LIMIT) {
    pending.shift();
  }
  pending.push({ message: '渲染层错误上报', detail });
}

/**
 * 安装全局错误兜底（main.tsx 顶部调用，React render 之前）
 *
 * - window error 事件：未捕获的同步异常
 * - unhandledrejection：未捕获的 Promise 拒绝（AbortError 等预期中断除外）
 */
export function initRendererErrorHandlers(): void {
  window.addEventListener('error', (event) => {
    reportError(event.error ?? event.message, { tags: { scope: 'window.onerror' } });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    // 已由调用方 catch 的错误（AbortError 等预期中断）不记录且不吞
    if (reason instanceof DOMException && reason.name === 'AbortError') {
      event.preventDefault();
      return;
    }
    reportError(reason, { tags: { scope: 'unhandledrejection' } });
  });
}
