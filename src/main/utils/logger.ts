import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';

/**
 * 测试环境标记（模块加载期求值）
 *
 * ⚠️ **文件落盘路径**必须在模块加载期就重定向到临时目录，不能只放在 initLogger() 里：
 * 纯 Node（vitest）下 electron-log 的默认路径解析会回退到**真实用户日志目录**
 * （%APPDATA%/code-agent-desktop/logs/main.log）。而单测通常不调用 initLogger()，
 * 于是任何在测试中被 import 的模块只要打了日志，就会污染用户日志与诊断包
 * （2026-09-21 实测：新增 autostart 日志后，跑一次单测即向用户 main.log 写入多条
 * 含测试夹具路径的记录）。
 *
 * 范围**仅限文件路径**：console 级别仍由 initLogger() 按 app.isPackaged 决定——
 * 把 console 也在此处锁死会让「dev 分支 console=debug」失去可测性（utils-gaps.test.ts
 * 覆盖该分支），且控制台输出不落盘、不污染任何持久状态。
 */
const IS_TEST_ENV = process.env['VITEST'] !== undefined || process.env['NODE_ENV'] === 'test';
if (IS_TEST_ENV) {
  log.transports.file.resolvePathFn = () => join(tmpdir(), 'code-agent-test-logs', 'main.log');
}

/**
 * 日志上下文（结构化字段）
 *
 * traceId 贯穿渲染层 → IPC → 主进程日志（云端上报已于 2026-09-13 移除，见 error-report.ts）
 * 设计文档 §4.7 traceId 贯穿 IPC
 */
export interface LogContext {
  /** 请求追踪 ID（贯穿 IPC 链路） */
  readonly traceId?: string;
  /** IPC channel 名（仅 IPC handler 日志） */
  readonly channel?: string;
  /** 业务实体 ID（如 projectId、chapterId） */
  readonly [key: string]: unknown;
}

/**
 * 初始化 logger 配置
 *
 * 设计文档 §7.6 的落地口径（轮转与保留以本注释为准）：
 * - 文件日志：单文件 10MB 上限，超出后当前文件移为 main.old.log——
 *   实际保留 main.log + main.old.log 两份（§7.6 原文「按日轮转、保留 14 天」未落地）
 * - 控制台：仅 dev 环境
 * - 文件位置：%APPDATA%/<AppName>/logs/main.log
 *
 * 必须在 app.whenReady() 之后调用（需要 app.getPath）
 */
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

/**
 * 统一 logger 接口类型
 *
 * 使用方式：
 * - logger.info({ traceId, channel }, 'IPC 请求开始')
 * - logger.error({ traceId }, '操作失败', error)
 */
export interface Logger {
  /** info 级别日志（关键业务事件） */
  info(context: LogContext, message: string): void;
  /** warn 级别日志（可重试错误、降级行为） */
  warn(context: LogContext, message: string): void;
  /** error 级别日志（系统错误、未捕获异常），error 可选附加 Error 对象 */
  error(context: LogContext, message: string, error?: unknown): void;
  /** debug 级别日志（仅 dev 环境输出） */
  debug(context: LogContext, message: string): void;
}

/**
 * 统一 logger 实例
 *
 * 使用方式：
 * - logger.info({ traceId, channel }, 'IPC 请求开始')
 * - logger.error({ traceId }, '操作失败', error)
 */
export const logger: Logger = {
  /**
   * info 级别日志（关键业务事件）
   */
  info(context: LogContext, message: string): void {
    log.info({ ...context, message });
  },

  /**
   * warn 级别日志（可重试错误、降级行为）
   */
  warn(context: LogContext, message: string): void {
    log.warn({ ...context, message });
  },

  /**
   * error 级别日志（系统错误、未捕获异常）
   *
   * @param error 可选的 Error 对象，会附加到日志
   */
  error(context: LogContext, message: string, error?: unknown): void {
    if (error !== undefined) {
      log.error({ ...context, message, error: serializeError(error) });
    } else {
      log.error({ ...context, message });
    }
  },

  /**
   * debug 级别日志（仅 dev 环境输出）
   */
  debug(context: LogContext, message: string): void {
    log.debug({ ...context, message });
  },
};

/**
 * 序列化 Error 对象为可日志的结构
 *
 * 保留 name / message / stack / cause，避免循环引用
 */
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

/**
 * 注册全局错误捕获
 *
 * 设计文档 §7.6：unhandledRejection / uncaughtException 全局捕获
 * 必须在 app.whenReady() 之后、业务逻辑之前调用
 *
 * 增强（可靠性极致）：
 * - 本地结构化日志落盘（云端上报已移除；报障走诊断包导出 + GitHub issue）
 * - 崩溃标记：uncaughtException 时写入 userData/.crash-marker，
 *   下次启动由崩溃恢复逻辑消费（标记中断的会话状态）
 *
 * 致命退出（2026-09-06 审计修复）：uncaughtException 后**不再继续运行**。
 * 此前只记日志 + 写 marker 就返回，进程带着可能已损坏的状态（悬挂事务、
 * 半写文件、断开的 stream）继续服务，同类异常可复发且污染崩溃恢复语义。
 * 现在：落盘 → 留 300ms 日志写盘窗口 → 退出（3s 强杀兜底）。不 relaunch，
 * 避免崩溃循环（用户手动重启即可）。
 */
let fatalErrorHandled = false;

/**
 * 等待异步文件日志落盘（退出链专用）
 *
 * sync=false 时 electron-log 经内部串行队列写盘（File 实例的 asyncWriteQueue +
 * hasActiveAsyncWriting，见 electron-log File.js），而 app.exit() 立即终止进程、
 * 不等队列——2026-10-01 实测：更新安装的退出链日志（含「应用已退出，拉起安装
 * 向导」）整体丢失，排障只能靠前后日志反推。uncaughtException 路径早有 300ms
 * 写盘窗口，正常退出链此前没有。
 *
 * 轮询内部队列清空即返回（无在途写时立即返回），timeoutMs 上限兜底；electron-log
 * 升级若改名内部字段（getFile/队列不可达），退化为直接返回——正确性不受影响，
 * 只是失去"等队列"的加速。
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
 * 注册全局错误处理器：uncaughtException / unhandledRejection 落盘 + 致命退出
 * （行为契约见上方 fatalErrorHandled 注释；幂等由模块级标志保证）
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

/** 崩溃标记文件路径（位于 userData 下） */
function getCrashMarkerPath(): string {
  return join(app.getPath('userData'), '.crash-marker');
}

/** 写入崩溃标记（uncaughtException 时调用，供下次启动恢复检测） */
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

/** 清除崩溃标记（正常启动流程消费后调用） */
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

/** 是否存在崩溃标记（上次进程异常退出的证据） */
export function hasCrashMarker(): boolean {
  return existsSync(getCrashMarkerPath());
}
