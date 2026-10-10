// logger.ts：主进程日志——electron-log 封装（文件 + console 双通道）、全局异常处理器、崩溃标记
// 边界：渲染层日志经 electron-log/renderer 转发到这里落盘；错误出口统一走 error-report.ts
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';

// 测试环境日志改写进系统临时目录，避免污染 userData / 触发打包路径断言
const IS_TEST_ENV = process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test';
if (IS_TEST_ENV) {
  log.transports.file.resolvePathFn = () => join(tmpdir(), 'code-agent-test-logs', 'main.log');
}

/** 结构化日志上下文：traceId/channel 之外的键自由扩展（进 JSON 字段） */
export interface LogContext {
  readonly traceId?: string;
  readonly channel?: string;
  readonly [key: string]: unknown;
}

/** 应用日志初始化（whenReady 启动序列首个调用；级别按打包态分级） */
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

/** 日志接口（结构化 context 前置 + message；error 可附原始错误） */
export interface Logger {
  info(context: LogContext, message: string): void;
  warn(context: LogContext, message: string): void;
  error(context: LogContext, message: string, error?: unknown): void;
  debug(context: LogContext, message: string): void;
}

/** 全局唯一 logger 实例（自定义包装而非直接暴露 electron-log：收口格式与错误序列化） */
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

// Error 序列化（name/message/stack/cause 递归）：electron-log 默认只取 message，丢 cause 链
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

/**
 * 等待 electron-log 异步写队列排空（退出善后链最后一步，防崩溃前最后几条日志丢失）
 *
 * electron-log 无公开 flush API，只能窥探 file transport 的内部队列轮询，300ms 内不排空就放弃
 */
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

/**
 * 全局异常兜底：uncaughtException 写日志 + 崩溃标记后退出（300ms 给日志落盘，3s 强杀兜底防挂死）；
 * unhandledRejection 只记录不退出（Promise 链局部失败不该杀进程）
 */
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

// 崩溃标记（.crash-marker）：启动序列 recoverFromCrash 检测到它才走「上次异常退出」分支，
// 清除时机在恢复完成后（finally），保证强杀/断电下次启动仍能被识别
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
