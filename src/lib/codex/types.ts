/**
 * Codex API 层的共享类型。
 *
 * 这些类型对应 codex-rs app-server-protocol 的数据结构。
 * 当真实的 specta 绑定可用时，这些占位类型将被替换为
 * `src/lib/bindings.ts` 中的导入。
 *
 * @see src/lib/bindings.ts — tauri-specta 自动生成的绑定
 */

/** Thread ID（codex-rs 的 thread 标识符） */
export type ThreadId = string

/** Turn ID（codex-rs 中 thread 内的 turn 标识符） */
export type TurnId = string

/** Thread 生命周期状态（对应 UI 侧边栏 tab） */
export type ThreadState = 'recent' | 'archived' | 'deleted' | 'closed'

/** Thread 元数据 — 可扩展的键值对 */
export interface ThreadMetadata {
  folder: string | null
  msgs: number
  title: string | null
  pinned: boolean
}

/** codex-rs thread 对象的元数据 */
export interface Thread {
  id: ThreadId
  title: string
  createdAt: number
  updatedAt: number
  archived: boolean
  archivedAt: number | null
  appId: string | null
  cwd: string | null
  forkedFromThreadId: string | null
  metadata: ThreadMetadata
  model: string
  modelProvider: string
}

/** 消息角色 */
export type MessageRole = 'user' | 'assistant' | 'system'

/** 消息内容类型 */
export type MessageContentType =
  | 'text'
  | 'tool_call'
  | 'tool_result'
  | 'file_change'
  | 'thinking'
  | 'reasoning'
  | 'approval'
  | 'plan'

// ─── 工具调用相关类型 ──────────────────────────────────────────

/** 工具调用执行状态 */
export type ToolCallStatus = 'running' | 'success' | 'error' | 'pending'

/**
 * 工具调用结构化数据
 * 对应 prototype.html 的 `.card.tool-card` 可折叠卡片
 */
export interface ToolCall {
  /** 工具调用唯一 ID */
  id: string
  /** 工具名称（如 exec_command, read_file, apply_patch） */
  name: string
  /** 工具调用参数（JSON 对象） */
  args: Record<string, unknown>
  /** 执行状态 */
  status: ToolCallStatus
  /** 执行结果文本（status 为 success/error 时有值） */
  result?: string
  /** 错误信息（status 为 error 时有值） */
  error?: string
  /** 执行耗时（毫秒） */
  durationMs?: number
}

// ─── 文件变更相关类型 ──────────────────────────────────────────

/** 文件变更类型 */
export type FileChangeType = 'created' | 'modified' | 'deleted'

/**
 * 单个文件的 diff 变更
 * 对应 prototype.html 的 `.card` + `.diff-file` + `.diff-lines`
 */
export interface FileChange {
  /** 文件路径（相对路径） */
  path: string
  /** 变更类型 */
  type: FileChangeType
  /** 新增行数 */
  additions: number
  /** 删除行数 */
  deletions: number
  /** diff 内容（按行分割） */
  diff: DiffLine[]
}

/** diff 单行数据 */
export interface DiffLine {
  /** 行类型：context（上下文）/ add（新增）/ del（删除） */
  type: 'context' | 'add' | 'del'
  /** 旧行号（del/context 有值） */
  oldLine?: number
  /** 新行号（add/context 有值） */
  newLine?: number
  /** 行内容 */
  content: string
}

// ─── 推理/思考相关类型 ──────────────────────────────────────────

/**
 * 推理摘要块
 * 对应 prototype.html 的 `.reasoning-block` 可折叠面板
 */
export interface ReasoningBlock {
  /** 推理块唯一 ID */
  id: string
  /** 推理内容文本 */
  content: string
  /** 推理耗时（毫秒） */
  durationMs: number
  /** Token 消耗数 */
  tokenCount: number
  /** 是否正在流式输出 */
  isStreaming: boolean
}

// ─── 内联审批相关类型 ──────────────────────────────────────────

/** 内联审批卡片状态 */
export type ApprovalCardStatus = 'pending' | 'approved' | 'rejected'

/** 审批操作类型 */
export type ApprovalAction = 'approve' | 'reject' | 'whitelist'

/**
 * 对话流内联审批卡片
 * 对应 prototype.html 的 `.card.paused` + `.approval-actions`
 */
export interface InlineApprovalCard {
  /** 审批请求 ID（与后端 requestId 对应） */
  requestId: string
  /**
   * 审批类型（7 种，与 ApprovalVariant / ApprovalType 完全对齐）。
   * - command：命令执行审批
   * - patch：文件变更 / 补丁应用审批（旧版 file_change 已合并到此）
   * - tool：工具输入请求（ToolRequestUserInput）
   * - mcp：MCP Elicitation 请求
   * - perm：权限审批（旧版 permissions 已重命名）
   * - dyn：动态工具调用
   * - attest：Attestation 生成
   */
  type:
    | 'command'
    | 'patch'
    | 'tool'
    | 'mcp'
    | 'perm'
    | 'dyn'
    | 'attest'
  /** 审批内容描述（如命令文本、文件路径） */
  payload: string
  /** 当前状态 */
  status: ApprovalCardStatus
  /** 用户执行的操作（status 变更后有值） */
  action?: ApprovalAction
}

// ─── 计划项类型 ──────────────────────────────────────────────

/** 计划项状态 */
export type PlanItemStatus = 'pending' | 'active' | 'done' | 'skipped'

/**
 * 执行计划中的单个步骤
 * 对应 prototype.html 的 `.plan-item`
 *
 * 支持任意层级嵌套（对齐原型 THREAD_PLANS 的树形结构）：
 *   - 叶子节点：无 children，通过 status 标记完成状态
 *   - 父节点：有 children，自身 done 状态由所有子节点 done 与否派生
 *
 * 向后兼容：children 为可选字段，旧后端返回的扁平 PlanItem[] 仍可正常渲染。
 */
export interface PlanItem {
  /** 步骤序号（从 1 开始，仅顶层节点有意义） */
  index: number
  /** 步骤描述文本 */
  text: string
  /** 当前状态 */
  status: PlanItemStatus
  /**
   * 子步骤列表（可选）。
   * 存在时表示当前项为父节点，渲染为可折叠的层级树。
   * 缺省时表示叶子节点，点击可切换完成状态。
   */
  children?: PlanItem[]
}

// ─── 流式增量类型 ──────────────────────────────────────────────

/**
 * 流式增量块类型
 * 用于 streaming-store 的增量 delta 追加
 */
export type StreamingDeltaType =
  | 'text' // 文本增量
  | 'tool_call_start' // 工具调用开始
  | 'tool_call_delta' // 工具调用参数增量
  | 'tool_call_end' // 工具调用结束
  | 'reasoning_delta' // 推理内容增量
  | 'file_change' // 文件变更通知
  | 'plan_update' // 计划更新（完整 PlanItem[] 列表，一次性替换）
  | 'plan_delta' // 计划增量文本（逐字追加，完成时解析为 PlanItem[]）
  | 'approval_request' // 审批请求
  | 'error' // 错误通知
  | 'done' // 流式结束

/**
 * 流式增量块
 * 对应 codex-rs 的 item/agentMessage/delta 事件 payload
 */
export interface StreamingChunk {
  /** 关联的 item ID（用于路由 delta 到正确的消息） */
  itemId: string
  /** 增量类型 */
  type: StreamingDeltaType
  /** 文本增量（type 为 text/reasoning_delta 时有值） */
  delta?: string
  /** 工具调用数据（type 为 tool_call_start 时有值） */
  toolCall?: ToolCall
  /** 文件变更数据（type 为 file_change 时有值） */
  fileChange?: FileChange
  /** 计划项列表（type 为 plan_update 时有值） */
  planItems?: PlanItem[]
  /** 审批请求（type 为 approval_request 时有值） */
  approval?: InlineApprovalCard
  /** 错误信息（type 为 error 时有值） */
  error?: string
  /** 时间戳 */
  timestamp: number
}

// ─── 消息类型扩展 ──────────────────────────────────────────────

/**
 * 扩展后的消息接口
 * 保留原有字段兼容性，新增结构化内容字段
 */
export interface Message {
  id: string
  role: MessageRole
  content: MessageContentType
  /** 文本内容（text 类型消息使用） */
  text: string
  timestamp: number
  /** 工具调用数据（content 为 tool_call/tool_result 时有值） */
  toolCall?: ToolCall
  /** 文件变更数据（content 为 file_change 时有值） */
  fileChange?: FileChange
  /** 推理块数据（content 为 thinking/reasoning 时有值） */
  reasoning?: ReasoningBlock
  /** 内联审批卡片（content 为 approval 时有值） */
  approval?: InlineApprovalCard
  /** 计划项列表（content 为 plan 时有值） */
  planItems?: PlanItem[]
  /** 是否正在流式输出 */
  isStreaming?: boolean
  /** 关联的 item ID（流式消息路由用） */
  itemId?: string
}

/** Turn 状态 */
export type TurnStatus =
  'pending' | 'running' | 'completed' | 'cancelled' | 'failed'

/** Turn 元数据 */
export interface Turn {
  id: TurnId
  threadId: ThreadId
  status: TurnStatus
  startedAt: number
  completedAt: number | null
}

/** 文件系统条目 */
export interface FileEntry {
  path: string
  name: string
  isDirectory: boolean
  size: number
  modifiedAt: number
}

/** MCP server 信息 */
export interface McpServer {
  id: string
  name: string
  transport: 'stdio' | 'sse' | 'websocket'
  command: string | null
  args: string[]
  env: Record<string, string>
  status: 'connected' | 'disconnected' | 'error'
  /** 已注册工具数量 */
  tools: number
  /** 已注册资源数量 */
  resources: number
  /** 错误信息（status 为 error 时） */
  error: string | null
}

/** MCP 工具 */
export interface McpTool {
  serverId: string
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** MCP 资源 */
export interface McpResource {
  serverId: string
  uri: string
  name: string
  description: string
  mimeType: string | null
}

/** MCP 工具调用结果（对齐 MCP 协议 CallToolResult） */
export interface McpToolCallResult {
  content: { type: 'text'; text: string }[]
  isError: boolean
}

/**
 * codex-rs 推送的审批请求（前端展示用）。
 *
 * 与 `approval.ts` 中的 `ApprovalRequestEvent` 区别：
 *  - `ApprovalRequest` 是面向 UI 卡片的简化结构（已在 bridge::mapper 中扁平化）；
 *  - `ApprovalRequestEvent` 是事件 payload 的原始结构（含 requestIdJson 等回传字段）。
 *
 * @see src/lib/codex/approval.ts — ApprovalRequestEvent 事件 payload 定义
 */
export interface ApprovalRequest {
  /** 审批请求 ID（与后端 requestId 对应，用于 submitApproval 回传） */
  requestId: string
  /** 审批类型：command(命令执行) / file_change(文件变更) / patch(补丁应用) / permissions(权限审批) */
  type: 'command' | 'file_change' | 'patch' | 'permissions'
  /** 审批内容描述（如命令文本、文件路径、补丁内容等，前端按 type 选择渲染方式） */
  payload: string
}

/**
 * 审批响应（用户点击批准/拒绝后构造，由 submitApproval 发送到后端）。
 *
 * @see src/lib/codex/approval.ts — submitApproval 实现
 */
export interface ApprovalResponse {
  /** 审批请求 ID（来自 ApprovalRequestEvent.requestIdJson） */
  requestId: string
  /** true=批准，false=拒绝 */
  approved: boolean
  /** 拒绝原因（仅 approved=false 时有意义，会作为 JSON-RPC error.message 回传后端） */
  reason?: string
}

/** 用户账户信息 */
export interface AccountInfo {
  email: string
  plan: string
  authMode: 'chatgpt' | 'api_key'
}

/** 命令执行结果 */
export interface CommandExecResult {
  commandId: string
  exitCode: number
  stdout: string
  stderr: string
  duration: number
}

/** 插件信息 */
export interface PluginInfo {
  id: string
  name: string
  version: string
  enabled: boolean
}

/** 进程信息 */
export interface ProcessInfo {
  pid: number
  name: string
  command: string
  cpuUsage: number
  memoryUsage: number
}

/** 配置快照 */
export interface CodexConfig {
  model: string
  temperature: number
  maxTokens: number
  approvalMode: 'auto' | 'manual' | 'hybrid'
  sandbox: boolean
}

// ─── UI 层后端数据类型 ────────────────────────────────────────

/**
 * 账户用量统计项
 *
 * 用于 AccountDialog 展示 5h/本周/Token 用量等指标。
 * Tauri 模式下由后端返回，浏览器模式从 MockData 获取。
 */
export interface UsageStat {
  /** 标签（如 "5h 用量"） */
  label: string
  /** 主值（百分比或数值，如 "42%" 或 "8.2k"） */
  value: string
  /** 副文本（如 "210 / 500"） */
  sub: string
  /** 进度条百分比（0-100），null 表示无进度条 */
  progress: number | null
  /** 是否使用 warn 色 */
  warn?: boolean
}

/**
 * 聊天输入框统计栏指标
 *
 * 用于 ChatInput 底部统计栏展示 token 速率、速率限制、安全缓冲等。
 * Tauri 模式下由后端或流式通知提供，浏览器模式从 MockData 获取。
 */
export interface ChatStats {
  /** 当前 token 速率（如 "2.3 tok/s"） */
  tokenRate: string
  /** 速率限制配额（如 "5h/1000"） */
  rateLimit: string
  /** 安全缓冲百分比（0-100） */
  safetyBufferPercent: number
  /** 模型重路由指示（如 "→ gpt-4o"） */
  modelReroute: string
}
