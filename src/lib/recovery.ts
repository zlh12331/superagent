/**
 * @file 数据恢复（recovery）模块。
 *
 * 职责：在崩溃或异常关闭后，从磁盘上的恢复文件还原用户数据。
 *
 * 架构位置：作为 Tauri 命令 `saveEmergencyData`/`loadEmergencyData`/
 *   `cleanupOldRecoveryFiles` 的前端封装，被 App.tsx 启动期、
 *   draft-store、crash-report-store 与 ErrorBoundary 调用。
 *
 * 设计要点：
 *  - Rust 侧负责磁盘 I/O 与大小校验，前端只关心 JSON 序列化；
 *  - saveEmergencyData / loadEmergencyData 在边界处与 Rust 交换 JSON 字符串，
 *    避免在 tauri-specta 中产生递归类型溢出；
 *  - FileNotFound 视为正常情况，loadEmergencyData 返回 null 而非抛错。
 */

import { logger } from '@/lib/logger'
import { commands, type RecoveryError } from '@/lib/tauri-bindings'

/**
 * 本地 JSON 值类型 —— 用于本模块对外的公共 API。
 *
 * 设计要点：Rust 命令接收/返回的是 JSON **字符串**（而非已解析的值），
 * 这是为了规避 tauri-specta 在 TypeScript codegen 阶段对递归类型
 * （JsonValue 自引用）产生的栈溢出。本模块在 save 时 stringify、
 * 在 load 时 parse，承担"结构化数据 <-> JSON 字符串"的边界转换。
 */
type JsonValue =
  | undefined
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * 将 RecoveryError 转换为人类可读的消息。
 *
 * 用于在抛出 Error 前将后端的强类型错误转为前端友好的字符串，
 *   便于 toast 提示或日志记录。
 *
 * @param error 来自 Rust 侧的 RecoveryError
 * @returns 已本地化的错误描述
 */
function formatRecoveryError(error: RecoveryError): string {
  switch (error.kind) {
    case 'FileNotFound':
      return 'File not found'
    case 'ValidationError':
      return `Validation error: ${error.message}`
    case 'DataTooLarge':
      return `Data too large (max ${error.max_bytes} bytes)`
    case 'IoError':
      return `IO error: ${error.message}`
    case 'ParseError':
      return `Parse error: ${error.message}`
  }
}

/**
 * 简单的数据恢复模式，用于将重要数据保存到磁盘
 *
 * 采用与偏好设置相同的方案 — JSON 文件存放在应用数据目录中
 * 文件保存到 ~/Library/Application Support/[app]/recovery/
 */

export interface RecoveryOptions {
  /** 抑制错误通知（适用于后台保存场景） */
  silent?: boolean
}

/**
 * 将任意可 JSON 序列化的数据保存到恢复文件
 *
 * @param filename 基础文件名（不含扩展名）
 * @param data 任意可 JSON 序列化的数据
 * @param options 恢复选项
 *
 * @example
 * ```typescript
 * // 保存用户草稿
 * await saveEmergencyData('user-draft', { content: 'Hello world', timestamp: Date.now() })
 *
 * // 在执行高风险操作前保存应用状态
 * await saveEmergencyData('app-state', { currentView: 'dashboard', unsavedChanges: true })
 * ```
 */
export async function saveEmergencyData(
  filename: string,
  data: JsonValue,
  options: RecoveryOptions = {}
): Promise<void> {
  logger.debug('Saving emergency data', { filename, dataType: typeof data })

  const result = await commands.saveEmergencyData(
    filename,
    JSON.stringify(data)
  )

  if (result.status === 'error') {
    const message = formatRecoveryError(result.error)
    logger.error('Failed to save emergency data', {
      filename,
      error: result.error,
    })
    throw new Error(message)
  }

  if (!options.silent) {
    logger.info('Emergency data saved successfully', { filename })
  }
}

/**
 * 从恢复文件加载数据
 *
 * @param filename 基础文件名（不含扩展名）
 * @returns 恢复的数据；若文件不存在则返回 null
 *
 * @example
 * ```typescript
 * // 加载用户草稿
 * const draft = await loadEmergencyData('user-draft')
 * if (draft) {
 *   console.log('Found saved draft:', draft.content)
 * }
 * ```
 */
export async function loadEmergencyData<T = unknown>(
  filename: string
): Promise<T | null> {
  logger.debug('Loading emergency data', { filename })

  const result = await commands.loadEmergencyData(filename)

  if (result.status === 'error') {
    // FileNotFound 是预期情况 — 返回 null 而不是抛出
    if (result.error.kind === 'FileNotFound') {
      logger.debug('Recovery file not found', { filename })
      return null
    }

    const message = formatRecoveryError(result.error)
    logger.error('Failed to load emergency data', {
      filename,
      error: result.error,
    })
    throw new Error(message)
  }

  logger.info('Emergency data loaded successfully', { filename })
  // 解析 Rust 命令返回的 JSON 字符串
  return JSON.parse(result.data) as T
}

/**
 * 清理旧的恢复文件（超过 7 天）
 * 在应用启动时自动调用
 *
 * @returns 被删除的文件数量
 *
 * @example
 * ```typescript
 * const removedCount = await cleanupOldFiles()
 * console.log(`Cleaned up ${removedCount} old recovery files`)
 * ```
 */
export async function cleanupOldFiles(): Promise<number> {
  logger.debug('Starting recovery file cleanup')

  const result = await commands.cleanupOldRecoveryFiles()

  if (result.status === 'error') {
    const message = formatRecoveryError(result.error)
    logger.error('Failed to cleanup old recovery files', {
      error: result.error,
    })
    throw new Error(message)
  }

  const removedCount = result.data
  if (removedCount > 0) {
    logger.info('Cleaned up old recovery files', { removedCount })
  } else {
    logger.debug('No old recovery files to clean up')
  }

  return removedCount
}

/**
 * 保存带时间戳的应用状态，用于崩溃恢复
 * 通常由错误边界 (error boundary) 调用
 *
 * @param state 当前要保存的应用状态
 * @param crashInfo 可选的崩溃信息
 *
 * @example
 * ```typescript
 * // 在错误边界中保存崩溃状态
 * await saveCrashState({
 *   currentPage: '/dashboard',
 *   userInput: formData,
 *   sessionId: 'abc123'
 * }, { error: error.message, stack: error.stack })
 * ```
 */
export async function saveCrashState(
  state: JsonValue,
  crashInfo?: {
    error?: string
    stack?: string
    componentStack?: string | undefined
  }
): Promise<void> {
  const timestamp = Date.now()
  const filename = `crash-${timestamp}`

  const crashData = {
    timestamp,
    state,
    crashInfo,
    userAgent: navigator.userAgent,
    url: window.location.href,
  }

  try {
    await saveEmergencyData(filename, crashData, { silent: true })
    logger.info('Crash state saved', { filename, timestamp })
  } catch (error) {
    // 不要从崩溃处理器中抛出 — 仅记录日志
    logger.error('Failed to save crash state', { error })
  }
}
