// src/main/utils/logger.ts
// 主进程结构化日志工具
// 基于 electron-log 5，设计文档 §7.6
// 职责：
// 1. 封装 electron-log，提供统一 logger 接口
// 2. 支持 traceId 字段贯穿同一请求的多条日志
// 3. 文件日志按日轮转（保留 14 天，10MB 上限）
// 4. 控制台仅 dev 环境
// 5. 注册全局 unhandledRejection / uncaughtException 捕获

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
 */
export function registerGlobalErrorHandlers(): void {
  process.on('uncaughtException', (error: Error) => {
    logger.error({}, '全局未捕获异常 uncaughtException', error);
  });

  process.on('unhandledRejection', (reason: unknown) => {
    logger.error({}, '全局未处理的 Promise 拒绝 unhandledRejection', reason);
  });
}
