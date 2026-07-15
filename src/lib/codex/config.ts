/**
 * Codex API — Config 域
 *
 * 配置管理：读取 / 设置 codex 配置。
 *
 * 后端命令已实现（3 个 Tauri command）：
 * - config_read — 读取当前生效的配置
 * - config_value_write — 写入单个配置项
 * - config_batch_write — 批量写入多个配置项
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 * 通过 isTauri() 检测以支持纯浏览器开发模式。
 *
 * 注意：`configValueWrite` 的 `value` 字段和 `configBatchWrite` 的 `edits`
 * 字段都是 JSON 字符串（规避 specta BigInt 禁令），前端需 `JSON.stringify`
 * 后传入。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — CodexConfig 类型
 */

import { commands } from '@/lib/tauri-bindings'
import type {
  ConfigReadArgs,
  ConfigValueWriteArgs,
  ConfigBatchWriteArgs,
} from '@/lib/bindings'
import type { CodexConfig } from './types'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的配置数据源与错误场景
import { getMockData, shouldFail, getMockError } from './mock'

// ---------------------------------------------------------------------------
// Tauri 响应类型（对应 codex-rs app-server-protocol 中的结构体）
// ---------------------------------------------------------------------------

/**
 * config/read 响应中的 config 对象（简化版，仅包含前端关心的字段）。
 *
 * 后端 Config 结构体使用 snake_case 序列化，字段很多；
 * 这里只声明前端 CodexConfig 需要的字段，其余字段忽略。
 */
interface ConfigData {
  model?: string | null
  model_context_window?: number | null
  approval_policy?: string | null
  sandbox_mode?: string | null
}

/** config/read 响应的 JSON 结构 */
interface ConfigReadResponse {
  config: ConfigData
}

/** config/batchWrite 的单个编辑项（对应后端 ConfigEdit） */
interface ConfigEditEntry {
  keyPath: string
  value: unknown
  mergeStrategy: string // "replace" | "upsert"
}

// ---------------------------------------------------------------------------
// 适配器：后端 Config ↔ 前端 CodexConfig
// ---------------------------------------------------------------------------

/**
 * 将后端 approval_policy 字符串适配为前端 approvalMode。
 *
 * 后端枚举值（kebab-case）：
 * - "never" → 不需要审批 → "auto"
 * - "on-request" → 按需审批 → "manual"
 * - "untrusted" → 仅非信任操作需审批 → "hybrid"
 */
function adaptApprovalMode(
  policy: string | null | undefined
): CodexConfig['approvalMode'] {
  switch (policy) {
    case 'never':
      return 'auto'
    case 'on-request':
      return 'manual'
    case 'untrusted':
      return 'hybrid'
    default:
      return 'manual'
  }
}

/**
 * 将前端 approvalMode 转换为后端 approval_policy 字符串。
 *
 * @see adaptApprovalMode — 反向映射
 */
function approvalModeToBackend(mode: CodexConfig['approvalMode']): string {
  switch (mode) {
    case 'auto':
      return 'never'
    case 'manual':
      return 'on-request'
    case 'hybrid':
      return 'untrusted'
  }
}

/**
 * 将后端 Config 对象适配为前端 CodexConfig 类型。
 *
 * 后端 Config 使用 snake_case 字段，前端 CodexConfig 使用 camelCase。
 * temperature 在后端没有直接对应字段，使用默认值。
 */
function adaptConfig(raw: ConfigData): CodexConfig {
  return {
    model: raw.model ?? 'gpt-5',
    // 后端 Config 没有 temperature 字段，使用默认值
    temperature: 0.3,
    maxTokens: raw.model_context_window ?? 8192,
    approvalMode: adaptApprovalMode(raw.approval_policy),
    // sandbox_mode 为 "danger-full-access" 时表示不沙箱化
    sandbox: raw.sandbox_mode !== 'danger-full-access',
  }
}

/**
 * 将前端 CodexConfig 的部分字段转换为后端 ConfigEdit[]。
 *
 * 每个变更项包含 keyPath（后端 snake_case 键路径）、value（JSON 值）
 * 和 mergeStrategy（"replace" 替换整个值）。
 *
 * @param config — 前端 CodexConfig 的部分字段
 * @returns 后端 ConfigEdit 数组
 */
function toConfigEdits(config: Partial<CodexConfig>): ConfigEditEntry[] {
  const edits: ConfigEditEntry[] = []
  if (config.model !== undefined) {
    edits.push({
      keyPath: 'model',
      value: config.model,
      mergeStrategy: 'replace',
    })
  }
  if (config.maxTokens !== undefined) {
    edits.push({
      keyPath: 'model_context_window',
      value: config.maxTokens,
      mergeStrategy: 'replace',
    })
  }
  if (config.approvalMode !== undefined) {
    edits.push({
      keyPath: 'approval_policy',
      value: approvalModeToBackend(config.approvalMode),
      mergeStrategy: 'replace',
    })
  }
  if (config.sandbox !== undefined) {
    edits.push({
      keyPath: 'sandbox_mode',
      value: config.sandbox ? 'workspace-write' : 'danger-full-access',
      mergeStrategy: 'replace',
    })
  }
  // temperature 没有对应的后端字段，跳过
  return edits
}

// ---------------------------------------------------------------------------
// API 函数
// ---------------------------------------------------------------------------

/**
 * 读取当前 codex 配置。
 *
 * Tauri 模式调用 `config/read` 命令，返回当前生效的配置。
 * 浏览器模式返回 mock 数据。
 *
 * @returns 前端 CodexConfig 对象
 */
export async function getConfig(): Promise<CodexConfig> {
  if (isTauri()) {
    const args: ConfigReadArgs = {}
    const result = await commands.configRead(args)
    if (result.status === 'error') {
      throw new Error(`config/read failed: ${result.error.message}`)
    }
    const parsed: ConfigReadResponse = JSON.parse(result.data)
    return adaptConfig(parsed.config)
  }
  // 浏览器开发模式 — error 场景按配置抛错，否则返回 mock 配置
  if (shouldFail('getConfig')) {
    throw getMockError('getConfig')
  }
  return getMockData().config
}

/**
 * 批量更新 codex 配置。
 *
 * Tauri 模式调用 `config/batchWrite` 命令，将多个配置项一次性写入。
 * 写入后重新调用 `config/read` 获取权威结果（后端可能覆盖值）。
 * 浏览器模式返回 mock 合并结果。
 *
 * 注意：`edits` 字段是 JSON 字符串（规避 specta BigInt 禁令），
 * 前端需 `JSON.stringify` 后传入。
 *
 * @param config — 要更新的部分配置字段
 * @returns 更新后的完整 CodexConfig
 */
export async function updateConfig(
  config: Partial<CodexConfig>
): Promise<CodexConfig> {
  if (isTauri()) {
    const edits = toConfigEdits(config)
    // 没有变更项时直接返回当前配置，跳过空写入
    if (edits.length === 0) {
      return await getConfig()
    }
    // edits 是 Vec<ConfigEdit> 的 JSON 字符串，需 JSON.stringify 后传入
    const args: ConfigBatchWriteArgs = {
      edits: JSON.stringify(edits),
    }
    const result = await commands.configBatchWrite(args)
    if (result.status === 'error') {
      throw new Error(`config/batchWrite failed: ${result.error.message}`)
    }
    // 写入后重新读取配置，返回权威结果
    return await getConfig()
  }
  return { ...getMockData().config, ...config }
}

/**
 * 写入单个配置项。
 *
 * Tauri 模式调用 `config/value/write` 命令，将指定键路径的值写入
 * 配置文件。浏览器模式为 no-op。
 *
 * 注意：`value` 字段是 JSON 字符串（规避 specta BigInt 禁令），
 * 前端需 `JSON.stringify` 后传入。
 *
 * @param keyPath — 配置键路径（如 "model"、"tools.webSearch"）
 * @param value — 配置值（会被 JSON.stringify）
 * @param mergeStrategy — 合并策略："replace"（替换）或 "upsert"（插入/更新）
 * @param filePath — 目标配置文件路径（可选，默认为用户 config.toml）
 */
export async function setConfigValue(
  keyPath: string,
  value: unknown,
  mergeStrategy: 'replace' | 'upsert' = 'replace',
  filePath?: string | null
): Promise<void> {
  if (isTauri()) {
    const args: ConfigValueWriteArgs = {
      keyPath,
      value: JSON.stringify(value),
      mergeStrategy,
      filePath: filePath ?? null,
    }
    const result = await commands.configValueWrite(args)
    if (result.status === 'error') {
      throw new Error(`config/value/write failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}
