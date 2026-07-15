/**
 * 前端日志工具。
 *
 * 路由策略（通过为每种机制分配单一且互不重叠的职责，解决“三重日志”问题）：
 * - **开发环境**：将日志输出到浏览器控制台，带 `[时间戳] [级别]`
 *   前缀，便于本地调试。
 * - **生产环境**：通过 `Sentry.logger` 将日志转发到 Sentry Logs（在自托管
 *   Sentry 实例上进行结构化日志聚合）。此时控制台输出会被抑制，以减少
 *   生产环境的噪音。
 *
 * 本模块直接引入 `@sentry/react`，而不是 `@/lib/sentry`，以避免循环依赖：
 * `sentry.ts` 引入了 `@/lib/tauri-bindings`，而 `logger.ts` 必须不与 Tauri
 * 耦合。当 SDK 未初始化或 `enableLogs` 关闭时，`Sentry.logger` 方法是空操作
 * (no-op)，因此可以无条件调用它们。
 *
 * 第三种日志机制 — Rust 侧的 `tauri-plugin-log` — 是独立的：Rust 日志在开发
 * 环境转发到 webview 控制台，在生产环境转发到应用日志目录。详见
 * `docs/developer/logging.en.md`。
 */
import * as Sentry from '@sentry/react'

/** 日志级别字面量联合类型，对齐 Sentry Logs 的级别语义。 */
type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

/**
 * 单条日志的内部表示，承载时间戳与可选结构化上下文。
 *
 * `context` 字段使用 `Record<string, unknown>` 以兼容 Sentry attributes 的
 * 任意键值结构；`undefined` 与缺省均表示无上下文，由 `exactOptionalPropertyTypes`
 * 强制区分以避免误传 undefined 被序列化为 null。
 */
interface LogEntry {
  level: LogLevel
  message: string
  timestamp: Date
  context?: Record<string, unknown> | undefined
}

/**
 * 日志路由器：根据构建环境将日志分发到不同后端。
 *
 * 设计要点：
 *  - 单例模式（下方 `export const logger`）保证全局日志行为一致；
 *  - 不依赖 `@/lib/sentry` 是为了规避循环依赖（sentry.ts 依赖 tauri-bindings，
 *    而 logger 须保持与 Tauri 解耦以便纯前端单测使用）；
 *  - 所有 `Sentry.logger.*` 在 SDK 未初始化或未授权时为 no-op，
 *    因此调用方无需关心 Sentry 当前状态。
 */
class Logger {
  private isDevelopment = import.meta.env.DEV

  /**
   * 记录一条 trace 级别的日志（最详细）
   */
  trace(message: string, context?: Record<string, unknown>): void {
    this.log('trace', message, context)
  }

  /**
   * 记录一条 debug 级别的日志（仅开发环境）
   */
  debug(message: string, context?: Record<string, unknown>): void {
    this.log('debug', message, context)
  }

  /**
   * 记录一条 info 级别的日志
   */
  info(message: string, context?: Record<string, unknown>): void {
    this.log('info', message, context)
  }

  /**
   * 记录一条 warn 级别的日志
   */
  warn(message: string, context?: Record<string, unknown>): void {
    this.log('warn', message, context)
  }

  /**
   * 记录一条 error 级别的日志
   */
  error(message: string, context?: Record<string, unknown>): void {
    this.log('error', message, context)
  }

  /**
   * 内部统一日志分发入口。
   *
   * 步骤：
   *  1. 装配 LogEntry（含 ISO 时间戳）；
   *  2. 按 `import.meta.env.DEV` 选择控制台或 Sentry 后端。
   *
   * 注意：分支基于构建期常量，Vite 会做 tree-shaking，生产构建中
   *   `logToConsole` 的代码会被 DCE 移除，避免暴露开发者日志格式。
   */
  private log(
    level: LogLevel,
    message: string,
    context?: Record<string, unknown>
  ): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date(),
      context,
    }

    // 开发环境：输出到控制台便于本地调试。
    // 生产环境：转发到 Sentry Logs（结构化的远程聚合）。
    if (this.isDevelopment) {
      this.logToConsole(entry)
    } else {
      this.logToSentry(entry)
    }
  }

  /**
   * 将日志格式化后输出到浏览器 console。
   *
   * 输出形如：`[2025-01-01T00:00:00.000Z] [INFO] message {context}`，
   * 选择 `console.debug/info/warn/error` 与级别对齐，便于 DevTools 过滤。
   */
  private logToConsole(entry: LogEntry): void {
    const timestamp = entry.timestamp.toISOString()
    const prefix = `[${timestamp}] [${entry.level.toUpperCase()}]`

    const args = entry.context
      ? [prefix, entry.message, entry.context]
      : [prefix, entry.message]

    switch (entry.level) {
      case 'trace':
      case 'debug':
        console.debug(...args)
        break
      case 'info':
        console.info(...args)
        break
      case 'warn':
        console.warn(...args)
        break
      case 'error':
        console.error(...args)
        break
    }
  }

  /**
   * 在生产环境中，将日志转发到 Sentry Logs（`Sentry.logger`）。
   *
   * 当 SDK 未初始化或 `enableLogs` 被禁用时，`Sentry.logger.{trace,debug,
   * info,warn,error}` 都是空操作 (no-op)，因此可以无条件调用。
   * 只有在用户授权后事件才会被发送（参见 `sentry.ts` → `beforeSend` 门控）。
   *
   * 当没有提供上下文时传入一个空的 attributes 对象，是为了在不针对每个
   * 日志级别做条件分支的情况下满足 `exactOptionalPropertyTypes` 的要求。
   */
  private logToSentry(entry: LogEntry): void {
    const attributes: Record<string, unknown> =
      entry.context !== undefined ? entry.context : {}
    switch (entry.level) {
      case 'trace':
        Sentry.logger.trace(entry.message, attributes)
        break
      case 'debug':
        Sentry.logger.debug(entry.message, attributes)
        break
      case 'info':
        Sentry.logger.info(entry.message, attributes)
        break
      case 'warn':
        Sentry.logger.warn(entry.message, attributes)
        break
      case 'error':
        Sentry.logger.error(entry.message, attributes)
        break
    }
  }
}

/**
 * 全局 logger 单例。
 *
 * 使用方式：
 *  - 推荐：`import { logger } from '@/lib/logger'` 然后调用 `logger.info(...)`；
 *  - 或直接解构：`import { info } from '@/lib/logger'`（便于在非 React 模块中使用）。
 *
 * 注意：在测试环境下推荐 mock 此模块而非 monkey-patch 单例。
 */
export const logger = new Logger()

/**
 * 便捷的独立日志函数（解构自 logger 单例）。
 *
 * 适用场景：在非类、非组件的纯函数模块中，避免显式 import logger 实例。
 * 行为与 logger 单例对应方法完全一致，绑定 `this` 后解构仍指向同一实例。
 */
export const { trace, debug, info, warn, error } = logger
