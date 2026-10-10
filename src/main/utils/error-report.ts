import { logger } from './logger';

export interface ErrorReportContext {
  readonly tags?: Readonly<Record<string, string>>;
  readonly componentStack?: string;
}

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

export function reportMessage(message: string, level: 'error' | 'warning' = 'error'): void {
  if (level === 'warning') {
    logger.warn({ scope: 'error-report' }, message);
  } else {
    logger.error({ scope: 'error-report' }, message);
  }
}
