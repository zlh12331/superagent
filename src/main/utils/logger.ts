// src/main/utils/logger.ts
// 主进程结构化日志工具
// 基于 electron-log 5，设计文档 §7.6
// 职责：
// 1. 封装 electron-log，提供统一 logger 接口
// 2. 支持 traceId 字段贯穿同一请求的多条日志
// 3. 文件日志按日轮转（保留 14 天，10MB 上限）
// 4. 控制台仅 dev 环境
// 5. 注册全局 unhandledRejection / uncaughtException 捕获

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app } from 'electron';
import log from 'electron-log';

/**
 * 日志上下文（结构化字段）
 *
 * traceId 贯穿渲染层 → IPC → 主进程日志 → Sentry
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
 * 设计文档 §7.6：
 * - 文件日志：按日轮转，保留 14 天，10MB 上限
 * - 控制台：仅 dev 环境
 * - 文件位置：%APPDATA%/<AppName>/logs/main.log
 *
 * 必须在 app.whenReady() 之后调用（需要 app.getPath）
 */
export function initLogger(): void {
  // 文件日志级别：生产 info，开发 debug
  log.transports.file.level = app.isPackaged ? 'info' : 'debug';
  // 控制台日志级别：仅 dev 启用
  log.transports.console.level = app.isPackaged ? false : 'debug';

  // 文件轮转配置：单文件 10MB 上限
  // electron-log 5 的轮转机制：超出 maxSize 后当前文件移为 main.old.log，新文件从空开始写
  // 仅保留 main.log + main.old.log 两个文件，不存在文件数量无限增长问题
  log.transports.file.fileName = 'main.log';
  log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB

  // 异步写盘（2026-09-08 性能修复）：
  // electron-log v5 文件传输默认 sync: true（内部 fs.writeFileSync），而
  // wrap.ts 每次 IPC invoke 固定记 2 条 info（请求开始 + 请求成功）——
  // 即每个 IPC 请求 2 次同步写盘。实测单次 appendFileSync 约 0.15 ms，
  // Windows + Defender 实时扫描下可放大到 1–5 ms，高频 channel
  // （session:list / system:getStatus）累计延迟可观。
  // 改异步后由 electron-log 内部队列合并写入，崩溃时最多丢失队列尾部若干行
  // （应用退出路径有 Sentry.close + 显式 flush，日志丢失窗口可接受）。
  log.transports.file.sync = false;

  // 日志格式：[ISO时间] [级别] [traceId] 消息
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
    // Error.cause 来自 ES2022.Error lib（tsconfig 已包含）
    // result 类型为 Record<string, unknown>，必须用方括号赋值（noPropertyAccessFromIndexSignature）
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
 * - Sentry 上报（logger 只落本地日志，崩溃现场需要云端可见）
 * - 崩溃标记：uncaughtException 时写入 userData/.crash-marker，
 *   下次启动由崩溃恢复逻辑消费（标记中断的会话状态）
 *
 * 致命退出（2026-09-06 审计修复）：uncaughtException 后**不再继续运行**。
 * 此前只记日志 + 写 marker 就返回，进程带着可能已损坏的状态（悬挂事务、
 * 半写文件、断开的 stream）继续服务，同类异常可复发且污染崩溃恢复语义。
 * 现在：落盘 → 上报 Sentry → 退出（3s 兜底，防 flush 卡死）。不 relaunch，
 * 避免崩溃循环（用户手动重启即可）。
 */
let fatalErrorHandled = false;

export function registerGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    // 重入保护：flush/退出过程中再次抛错时不再递归
    if (fatalErrorHandled) {
      return;
    }
    fatalErrorHandled = true;
    logger.error({}, '全局未捕获异常 uncaughtException', error);
    writeCrashMarker(error);
    // 兜底：flush 未在 3s 内完成也强制退出（避免挂死在半崩溃状态）
    const forceExit = setTimeout(() => {
      app.exit(1);
    }, 3_000);
    forceExit.unref();
    void captureToSentry(error).finally(() => {
      clearTimeout(forceExit);
      app.exit(1);
    });
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({}, '全局未处理的 Promise 拒绝 unhandledRejection', reason);
    if (reason instanceof Error) {
      void captureToSentry(reason);
    }
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
    // 标记写入失败不影响主流程
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

/** Sentry 上报（Sentry 可能未初始化，try 包裹保证不抛） */
async function captureToSentry(error: Error): Promise<void> {
  try {
    const Sentry = await import('@sentry/electron/main');
    Sentry.captureException(error);
  } catch {
    // Sentry 未初始化或不可用时静默降级（logger 已记录）
  }
}

/**
 * 上报消息级事件到 Sentry（供非 Error 的系统事件：进程崩溃/内存告警等）
 *
 * Sentry 可能未初始化（遥测 off / DSN 未配置），try 包裹保证不抛。
 * 供 window.ts 渲染崩溃自愈等模块复用，避免各自动态 import。
 */
export async function captureSentryMessage(
  message: string,
  level: 'warning' | 'error' = 'error',
): Promise<void> {
  try {
    const Sentry = await import('@sentry/electron/main');
    Sentry.captureMessage(message, level);
  } catch {
    // Sentry 未初始化或不可用时静默降级（调用方应已 logger 记录）
  }
}
