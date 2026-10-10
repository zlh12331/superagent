import { logger } from './logger';

/** 错误上报上下文（结构化字段，随日志落盘） */
export interface ErrorReportContext {
  /** 分组/来源标签（原 Sentry tags 语义） */
  readonly tags?: Readonly<Record<string, string>>;
  /** React 组件栈（错误边界场景，帮助定位出错组件） */
  readonly componentStack?: string;
}

/**
 * 上报错误（原 Sentry.captureException 收敛点）
 *
 * @param error 任意错误（Error / string / unknown reason）
 * @param context 结构化上下文（tags / componentStack）
 */
export function reportError(error: unknown, context?: ErrorReportContext): void {
  logger.error(
    {
      ...(context?.tags ?? {}),
      ...(context?.componentStack !== undefined ? { componentStack: context.componentStack } : {}),
    },
    '错误上报',
    error,
  );
}

/**
 * 上报消息级事件（原 Sentry.captureMessage 收敛点）
 *
 * 供非 Error 的系统事件使用：进程崩溃自愈 / 内存告警 / 事件循环阻塞等。
 *
 * @param message 消息文本
 * @param level 严重级别（warning → 日志 warn；error → 日志 error）
 */
export function reportMessage(message: string, level: 'error' | 'warning' = 'error'): void {
  if (level === 'warning') {
    logger.warn({ scope: 'error-report' }, message);
  } else {
    logger.error({ scope: 'error-report' }, message);
  }
}
