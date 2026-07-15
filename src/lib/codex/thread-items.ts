/**
 * ThreadItem → Message 适配层
 *
 * 后端 `thread/read(includeTurns=true)` 返回的 turn.items 是 ThreadItem 枚举数组
 *（18 个变体，JSON tag 为 `type`）。前端 Message 类型只有 8 种 content，
 * 需要本适配层做类型映射。
 *
 * ## 核心变体映射（8 个）
 *
 * | ThreadItem 变体 | Message.content | Message.role | 说明 |
 * |---|---|---|---|
 * | userMessage       | text        | user      | 用户输入，拼接 content[].text |
 * | agentMessage      | text        | assistant | AI 回复文本 |
 * | reasoning         | reasoning   | assistant | 推理过程 |
 * | plan              | plan        | assistant | 执行计划 |
 * | commandExecution  | tool_call   | assistant | 命令执行 |
 * | fileChange        | file_change | assistant | 文件变更 |
 * | mcpToolCall       | tool_call   | assistant | MCP 工具调用 |
 * | 其余 11 个        | text        | assistant | fallback：显示类型名 |
 *
 * ## 不映射的变体（走 fallback）
 *
 * hookPrompt / dynamicToolCall / collabAgentToolCall / subAgentActivity /
 * webSearch / imageView / sleep / imageGeneration / enteredReviewMode /
 * exitedReviewMode / contextCompaction
 *
 * 这些变体桌面端暂不需要独立展示，fallback 为带类型标签的占位文本。
 *
 * @see src/lib/codex/types.ts — Message 类型定义
 * @see src-tauri/codex-rs/app-server-protocol/src/protocol/v2/item.rs — 后端 ThreadItem 定义
 */

import type {
  Message,
  MessageContentType,
  MessageRole,
  ToolCall,
  ToolCallStatus,
  FileChange,
  FileChangeType,
  DiffLine,
  ReasoningBlock,
  PlanItem,
} from './types'

// =============================================================================
// 后端原始类型（镜像 codex-rs app-server-protocol ThreadItem 枚举）
// =============================================================================

/**
 * 后端 ThreadItem 的判别式联合类型。
 *
 * 后端使用 `#[serde(tag = "type", rename_all = "camelCase")]`，
 * 因此每个变体的 JSON 都有一个 `type` 字段做判别。
 */
export type RawThreadItem =
  | RawUserMessageItem
  | RawHookPromptItem
  | RawAgentMessageItem
  | RawPlanItem
  | RawReasoningItem
  | RawCommandExecutionItem
  | RawFileChangeItem
  | RawMcpToolCallItem
  | RawDynamicToolCallItem
  | RawCollabAgentToolCallItem
  | RawSubAgentActivityItem
  | RawWebSearchItem
  | RawImageViewItem
  | RawSleepItem
  | RawImageGenerationItem
  | RawEnteredReviewModeItem
  | RawExitedReviewModeItem
  | RawContextCompactionItem

/** userMessage 变体 */
interface RawUserMessageItem {
  type: 'userMessage'
  id: string
  clientId?: string | null
  /** 用户输入内容数组，每个元素含 text 字段 */
  content: ({ text?: string } | string)[]
}

/** hookPrompt 变体（fallback） */
interface RawHookPromptItem {
  type: 'hookPrompt'
  id: string
  fragments: { text: string; hookRunId: string }[]
}

/** agentMessage 变体 */
interface RawAgentMessageItem {
  type: 'agentMessage'
  id: string
  text: string
  phase?: string | null
}

/** plan 变体 */
interface RawPlanItem {
  type: 'plan'
  id: string
  text: string
}

/** reasoning 变体 */
interface RawReasoningItem {
  type: 'reasoning'
  id: string
  summary?: string[]
  content?: string[]
}

/** commandExecution 变体 */
interface RawCommandExecutionItem {
  type: 'commandExecution'
  id: string
  command: string
  cwd?: string
  processId?: string | null
  source?: string
  status: string
  commandActions?: { type: string; command?: string }[]
  aggregatedOutput?: string | null
  exitCode?: number | null
  durationMs?: number | null
}

/** fileChange 变体 */
interface RawFileChangeItem {
  type: 'fileChange'
  id: string
  changes: {
    path: string
    kind: { type: string; movePath?: string | null }
    diff: string
  }[]
  status: string
}

/** mcpToolCall 变体 */
interface RawMcpToolCallItem {
  type: 'mcpToolCall'
  id: string
  server: string
  tool: string
  status: string
  arguments: unknown
  result?: { content?: { type: string; text?: string }[] } | null
  error?: { message?: string } | null
  durationMs?: number | null
}

/** dynamicToolCall 变体（fallback） */
interface RawDynamicToolCallItem {
  type: 'dynamicToolCall'
  id: string
  namespace?: string | null
  tool: string
  arguments: unknown
  status: string
}

/** collabAgentToolCall 变体（fallback） */
interface RawCollabAgentToolCallItem {
  type: 'collabAgentToolCall'
  id: string
  tool: string
  status: string
  senderThreadId: string
}

/** subAgentActivity 变体（fallback） */
interface RawSubAgentActivityItem {
  type: 'subAgentActivity'
  id: string
  kind: string
  agentThreadId: string
}

/** webSearch 变体（fallback） */
interface RawWebSearchItem {
  type: 'webSearch'
  id: string
  query: string
}

/** imageView 变体（fallback） */
interface RawImageViewItem {
  type: 'imageView'
  id: string
  path: string
}

/** sleep 变体（fallback） */
interface RawSleepItem {
  type: 'sleep'
  id: string
  durationMs: number
}

/** imageGeneration 变体（fallback） */
interface RawImageGenerationItem {
  type: 'imageGeneration'
  id: string
  status: string
  result: string
}

/** enteredReviewMode 变体（fallback） */
interface RawEnteredReviewModeItem {
  type: 'enteredReviewMode'
  id: string
  review: string
}

/** exitedReviewMode 变体（fallback） */
interface RawExitedReviewModeItem {
  type: 'exitedReviewMode'
  id: string
  review: string
}

/** contextCompaction 变体（fallback） */
interface RawContextCompactionItem {
  type: 'contextCompaction'
  id: string
}

/**
 * 后端 Turn 结构（镜像 codex-rs Turn，只保留适配所需字段）。
 *
 * `items` 字段在 `thread/read(includeTurns=true)` 时填充。
 */
export interface RawTurn {
  id: string
  /** turn 中的 ThreadItem 列表（核心数据源） */
  items?: RawThreadItem[]
  /** 其他字段暂不声明，按需扩展 */
}

// =============================================================================
// 适配函数
// =============================================================================

/**
 * 将后端 ThreadItem 数组转换为前端 Message 数组。
 *
 * 遍历每个 ThreadItem，按 type 变体映射为对应 content 类型的 Message。
 * 不识别的变体走 fallback，生成占位文本消息。
 *
 * @param items — 后端返回的 ThreadItem 数组
 * @returns 前端 Message 数组（保持原序）
 */
export function threadItemsToMessages(items: RawThreadItem[]): Message[] {
  return items.map(threadItemToMessage)
}

/**
 * 将单个 ThreadItem 转换为 Message。
 *
 * 按变体类型分发到对应的转换函数，未识别的变体走 fallback。
 */
function threadItemToMessage(item: RawThreadItem): Message {
  switch (item.type) {
    case 'userMessage':
      return adaptUserMessage(item)
    case 'agentMessage':
      return adaptAgentMessage(item)
    case 'reasoning':
      return adaptReasoning(item)
    case 'plan':
      return adaptPlan(item)
    case 'commandExecution':
      return adaptCommandExecution(item)
    case 'fileChange':
      return adaptFileChange(item)
    case 'mcpToolCall':
      return adaptMcpToolCall(item)
    default:
      return adaptFallback(item)
  }
}

// -----------------------------------------------------------------------------
// 核心变体适配函数
// -----------------------------------------------------------------------------

/**
 * userMessage → Message(role='user', content='text')
 *
 * 用户输入的 content 是数组，每个元素可能是字符串或含 text 字段的对象。
 * 拼接所有文本为单条消息。
 */
function adaptUserMessage(item: RawUserMessageItem): Message {
  const text = item.content
    .map(c => (typeof c === 'string' ? c : (c.text ?? '')))
    .join('')
  return {
    id: item.id,
    role: 'user' as MessageRole,
    content: 'text' as MessageContentType,
    text,
    timestamp: Date.now(),
    itemId: item.id,
  }
}

/**
 * agentMessage → Message(role='assistant', content='text')
 */
function adaptAgentMessage(item: RawAgentMessageItem): Message {
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'text' as MessageContentType,
    text: item.text,
    timestamp: Date.now(),
    itemId: item.id,
  }
}

/**
 * reasoning → Message(role='assistant', content='reasoning')
 *
 * 后端的 summary 和 content 数组拼接为推理文本。
 */
function adaptReasoning(item: RawReasoningItem): Message {
  const summaryText = (item.summary ?? []).join('\n')
  const contentText = (item.content ?? []).join('\n')
  const fullText = [summaryText, contentText].filter(Boolean).join('\n\n')
  const reasoning: ReasoningBlock = {
    id: item.id,
    content: fullText,
    durationMs: 0,
    tokenCount: 0,
    isStreaming: false,
  }
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'reasoning' as MessageContentType,
    text: fullText,
    timestamp: Date.now(),
    reasoning,
    itemId: item.id,
  }
}

/**
 * plan → Message(role='assistant', content='plan')
 *
 * 后端 plan 的 text 是完整的计划文本，按行分割为 PlanItem 数组。
 * 每行作为一个步骤，状态默认 pending。
 */
function adaptPlan(item: RawPlanItem): Message {
  const lines = item.text.split('\n').filter(l => l.trim().length > 0)
  const planItems: PlanItem[] = lines.map((line, index) => ({
    index: index + 1,
    text: line.replace(/^\d+\.\s*/, ''), // 去除行号前缀
    status: 'pending' as const,
  }))
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'plan' as MessageContentType,
    text: item.text,
    timestamp: Date.now(),
    planItems,
    itemId: item.id,
  }
}

/**
 * commandExecution → Message(role='assistant', content='tool_call')
 *
 * 命令执行映射为 ToolCall，status 字符串映射为 ToolCallStatus 枚举。
 */
function adaptCommandExecution(item: RawCommandExecutionItem): Message {
  const toolCall: ToolCall = {
    id: item.id,
    name: 'exec_command',
    args: { command: item.command, cwd: item.cwd },
    status: mapCommandStatus(item.status),
    ...(item.aggregatedOutput ? { result: item.aggregatedOutput } : {}),
    ...(item.exitCode !== null && item.exitCode !== 0 && item.exitCode !== undefined
      ? { error: `Exit code: ${item.exitCode}` }
      : {}),
    ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
  }
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'tool_call' as MessageContentType,
    text: item.command,
    timestamp: Date.now(),
    toolCall,
    itemId: item.id,
  }
}

/**
 * fileChange → Message(role='assistant', content='file_change')
 *
 * 后端的 changes 数组转换为前端 FileChange 数组（取第一个变更）。
 * diff 文本按行解析为 DiffLine 数组。
 */
function adaptFileChange(item: RawFileChangeItem): Message {
  const firstChange = item.changes[0]
  const fileChange: FileChange | undefined = firstChange
    ? {
        path: firstChange.path,
        type: mapFileChangeType(firstChange.kind.type),
        additions: countDiffLines(firstChange.diff, 'add'),
        deletions: countDiffLines(firstChange.diff, 'del'),
        diff: parseDiffLines(firstChange.diff),
      }
    : undefined
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'file_change' as MessageContentType,
    text: firstChange?.path ?? '',
    timestamp: Date.now(),
    ...(fileChange ? { fileChange } : {}),
    itemId: item.id,
  }
}

/**
 * mcpToolCall → Message(role='assistant', content='tool_call')
 *
 * MCP 工具调用映射为 ToolCall，result.content[].text 拼接为结果文本。
 */
function adaptMcpToolCall(item: RawMcpToolCallItem): Message {
  const resultText = item.result?.content
    ?.map(c => c.text ?? '')
    .join('\n') ?? ''
  const toolCall: ToolCall = {
    id: item.id,
    name: `mcp:${item.server}.${item.tool}`,
    args: (item.arguments as Record<string, unknown>) ?? {},
    status: mapMcpStatus(item.status),
    ...(resultText ? { result: resultText } : {}),
    ...(item.error?.message ? { error: item.error.message } : {}),
    ...(item.durationMs != null ? { durationMs: item.durationMs } : {}),
  }
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'tool_call' as MessageContentType,
    text: `${item.server} / ${item.tool}`,
    timestamp: Date.now(),
    toolCall,
    itemId: item.id,
  }
}

// -----------------------------------------------------------------------------
// Fallback 适配
// -----------------------------------------------------------------------------

/**
 * 未识别的 ThreadItem 变体的兜底处理。
 *
 * 生成占位文本消息，标注原始类型名，方便调试和后续扩展。
 */
function adaptFallback(item: RawThreadItem): Message {
  return {
    id: item.id,
    role: 'assistant' as MessageRole,
    content: 'text' as MessageContentType,
    text: `[${item.type}]`,
    timestamp: Date.now(),
    itemId: item.id,
  }
}

// =============================================================================
// 辅助函数
// =============================================================================

/**
 * 后端 CommandExecutionStatus 字符串 → 前端 ToolCallStatus 枚举。
 *
 * 后端状态：InProgress / Completed / Failed / Declined
 */
function mapCommandStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'declined':
      return 'error'
    case 'inProgress':
      return 'running'
    default:
      return 'pending'
  }
}

/**
 * 后端 McpToolCallStatus 字符串 → 前端 ToolCallStatus 枚举。
 *
 * 后端状态：InProgress / Completed / Failed
 */
function mapMcpStatus(status: string): ToolCallStatus {
  switch (status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'inProgress':
      return 'running'
    default:
      return 'pending'
  }
}

/**
 * 后端 PatchChangeKind.type 字符串 → 前端 FileChangeType 枚举。
 *
 * 后端类型：add / delete / update
 */
function mapFileChangeType(kindType: string): FileChangeType {
  switch (kindType) {
    case 'add':
      return 'created'
    case 'delete':
      return 'deleted'
    case 'update':
      return 'modified'
    default:
      return 'modified'
  }
}

/**
 * 统计 diff 文本中指定类型的行数。
 *
 * diff 格式遵循 unified diff：
 * - `+` 开头为新增行
 * - `-` 开头为删除行
 */
function countDiffLines(diff: string, type: 'add' | 'del'): number {
  const prefix = type === 'add' ? '+' : '-'
  return diff
    .split('\n')
    .filter(line => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`))
    .length
}

/**
 * 将 unified diff 文本解析为 DiffLine 数组。
 *
 * 只解析实际的 diff 行（以 +/−/空格开头），跳过 hunk 头（@@）和文件头。
 */
function parseDiffLines(diff: string): DiffLine[] {
  const lines = diff.split('\n')
  const result: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of lines) {
    // hunk 头：@@ -1,3 +1,4 @@
    const hunkMatch = line.match(/^@@ -(\d+),?\d* \+(\d+),?\d* @@/)
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1] ?? '0', 10)
      newLine = parseInt(hunkMatch[2] ?? '0', 10)
      continue
    }

    if (line.startsWith('+++') || line.startsWith('---')) {
      continue
    }

    if (line.startsWith('+')) {
      result.push({ type: 'add', newLine: newLine++, content: line.slice(1) })
    } else if (line.startsWith('-')) {
      result.push({ type: 'del', oldLine: oldLine++, content: line.slice(1) })
    } else if (line.startsWith(' ')) {
      result.push({
        type: 'context',
        oldLine: oldLine++,
        newLine: newLine++,
        content: line.slice(1),
      })
    }
  }

  return result
}
