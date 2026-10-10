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
      for (const item of pending) {
        mod.default.error({ message: item.message }, item.detail);
      }
      pending.length = 0;
    })
    .catch(() => {});
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
    if (reason instanceof DOMException && reason.name === 'AbortError') {
      event.preventDefault();
      return;
    }
    reportError(reason, { tags: { scope: 'unhandledrejection' } });
  });
}
