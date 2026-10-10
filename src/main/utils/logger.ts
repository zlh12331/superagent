import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';

const IS_TEST_ENV = process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test';
if (IS_TEST_ENV) {
  log.transports.file.resolvePathFn = () => join(tmpdir(), 'code-agent-test-logs', 'main.log');
}

export interface LogContext {
  readonly traceId?: string;
  readonly channel?: string;
  readonly [key: string]: unknown;
}

export function initLogger(): void {
  log.transports.file.level = app.isPackaged ? 'info' : 'debug';
  log.transports.console.level = app.isPackaged ? false : 'debug';

  log.transports.file.fileName = 'main.log';
  log.transports.file.maxSize = 10 * 1024 * 1024;

  log.transports.file.sync = false;

  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';
  log.transports.console.format = '{level} {text}';

  log.initialize();
}

export interface Logger {
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string, error?: unknown): void;
  debug(context: LogContext, message: string): void;
}

export const logger: Logger = {
  info(context: LogContext, message: string): void {
    log.info({ ...context, message });
  },

  warn(context: LogContext, message: string): void {
    log.warn({ ...context, message });
  },

  error(context: LogContext, message: string, error?: unknown): void {
    if (error !== undefined) {
      log.error({ ...context, message, error: serializeError(error) });
    } else {
      log.error({ ...context, message });
    }
  },

  debug(context: LogContext, message: string): void {
    log.debug({ ...context, message });
  },
};

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const result: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    if (error.cause !== undefined) {
      result['cause'] = serializeError(error.cause);
    }
    return result;
  }
  return { value: String(error) };
}

let fatalErrorHandled = false;

export async function flushPendingLogs(timeoutMs = 300): Promise<void> {
  const file = (
    log.transports.file as unknown as {
      getFile?(): { asyncWriteQueue: string[]; hasActiveAsyncWriting: boolean } | undefined;
    }
  ).getFile?.();
  if (file === undefined) {
    return;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && (file.asyncWriteQueue.length > 0 || file.hasActiveAsyncWriting)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function registerGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    if (fatalErrorHandled) {
      return;
    }
    fatalErrorHandled = true;
    logger.error({}, '全局未捕获异常 uncaughtException', error);
    writeCrashMarker(error);
    setTimeout(() => {
      app.exit(1);
    }, 300).unref();
    const forceExit = setTimeout(() => {
      app.exit(1);
    }, 3_000);
    forceExit.unref();
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({}, '全局未处理的 Promise 拒绝 unhandledRejection', reason);
  });
}

function getCrashMarkerPath(): string {
  return join(app.getPath('userData'), '.crash-marker');
}

function writeCrashMarker(error: Error): void {
  try {
    const markerPath = getCrashMarkerPath();
    mkdirSync(dirname(markerPath), { recursive: true });
    writeFileSync(
      markerPath,
      JSON.stringify({ timestamp: Date.now(), message: error.message }),
      'utf8',
    );
    logger.info({ markerPath }, '已写入崩溃标记');
  } catch (writeError) {
    logger.error({ error: String(writeError) }, '崩溃标记写入失败');
  }
}

export function clearCrashMarker(): void {
  try {
    const markerPath = getCrashMarkerPath();
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
      logger.info({ markerPath }, '已清除崩溃标记');
    }
  } catch (error) {
    logger.error({ error: String(error) }, '崩溃标记清除失败');
  }
}

export function hasCrashMarker(): boolean {
  return existsSync(getCrashMarkerPath());
}
