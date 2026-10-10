// error-report.ts：错误上报单一出口——主进程一切异常经这里落本地日志（本地优先，无云端上报）
// 将来接任何后端只改本文件；渲染层对应物在 src/renderer/lib/error-report.ts（经 electron-log 转发主进程）
import { logger } from './logger';

/** 上报附加上下文：tags 进结构化字段；componentStack 供渲染层 React 组件栈（转发场景） */
export interface ErrorReportContext {
  readonly tags?: Readonly<Record<string, string>>;
  readonly componentStack?: string;
}

/** 上报异常（统一 message 前缀「错误上报」，便于日志检索聚合） */
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

/** 上报一条消息（无异常对象时用；warning 级用于「疑似问题但不致命」场景，如内存增长） */
export function reportMessage(message: string, level: 'error' | 'warning' = 'error'): void {
  if (level === 'warning') {
    logger.warn({ scope: 'error-report' }, message);
  } else {
    logger.error({ scope: 'error-report' }, message);
  }
}
