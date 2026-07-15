/**
 * Mock 层类型定义
 *
 * 定义 mock 场景切换所需的数据结构与错误场景配置。
 * 所有 API 文件的 mock 数据通过 MockData 接口统一管理，
 * 实现"数据集中、场景可切"的架构目标。
 *
 * @see src/lib/codex/types.ts — 各领域实体类型定义
 */

import type {
  Thread,
  Message,
  Turn,
  AccountInfo,
  CodexConfig,
  FileEntry,
  McpServer,
  McpTool,
  McpResource,
  PluginInfo,
  ProcessInfo,
  CommandExecResult,
  UsageStat,
  ChatStats,
} from '../types'
import type { FileTreeNode, FuzzySearchResult } from '@/features/file-tree/types'

/**
 * Mock 场景类型
 *
 * - normal: 正常数据（多线程、多消息、多服务器），用于功能开发
 * - boundary: 边界数据（全空），用于空状态 UI 调试
 * - error: 错误数据（API 抛错），用于错误处理 UI 调试
 *
 * 通过 VITE_MOCK_SCENARIO 环境变量在编译时注入，
 * 运行时不可切换（避免状态不一致）。
 */
export type MockScenario = 'normal' | 'boundary' | 'error'

/**
 * 线程目标 mock 数据结构
 * 对齐 thread/goal/get 响应的 ThreadGoalGetResponse（thread.ts L585-592）。
 */
export interface ThreadGoalMock {
  /** 目标描述文本（无目标时为 null） */
  objective: string | null
  /** 目标状态（active/paused/blocked/usageLimited/budgetLimited/complete） */
  status: string | null
  /** Token 预算（null 表示无限制） */
  tokenBudget: number | null
}

/**
 * Mock 数据集合
 *
 * 汇总所有 API 文件需要的 mock 数据，按领域分字段。
 * 每个场景（normal/boundary/error）提供一份完整的 MockData。
 *
 * error 场景下仍使用 normalMockData 作为基础数据，
 * 仅在 shouldFail 返回 true 时抛错（保证部分 API 仍可调用）。
 */
export interface MockData {
  // ─── Thread 域 ──────────────────────────────────────────
  /** 线程列表（listThreads / searchThreads / listLoadedThreads 使用） */
  threads: Thread[]
  /** 消息列表（listMessages 使用） */
  messages: Message[]
  /** 单个 Turn（startTurn mock 返回，实际由 createMockTurn 工厂生成） */
  turn: Turn
  /**
   * 线程目标映射（getThreadGoal / clearThreadGoal 使用）
   * key=threadId，value=目标信息；未在映射中的线程视为无目标。
   */
  threadGoals: Record<string, ThreadGoalMock>

  // ─── Account 域 ─────────────────────────────────────────
  /** 账户信息（getAccount 使用，null 表示未登录） */
  account: AccountInfo | null

  // ─── Config 域 ──────────────────────────────────────────
  /** codex 配置（getConfig 使用） */
  config: CodexConfig

  // ─── FS 域 ──────────────────────────────────────────────
  /** 目录条目列表（listDirectory 使用） */
  fileEntries: FileEntry[]
  /** 文件树根节点（getFileTree 使用） */
  fileTree: FileTreeNode
  /** 全量文件列表（fuzzyFileSearch 使用） */
  allFiles: FuzzySearchResult[]

  // ─── MCP 域 ─────────────────────────────────────────────
  /** MCP 服务器列表（listMcpServers 使用） */
  mcpServers: McpServer[]
  /** MCP 工具列表（listMcpTools 使用，按 serverId 过滤） */
  mcpTools: McpTool[]
  /** MCP 资源列表（listMcpResources 使用，按 serverId 过滤） */
  mcpResources: McpResource[]

  // ─── 其他域 ─────────────────────────────────────────────
  /** 插件列表（listPlugins 使用） */
  plugins: PluginInfo[]
  /** 进程列表（listProcesses / getProcessInfo 使用） */
  processes: ProcessInfo[]
  /** 命令执行结果（executeCommand / getCommandResult 使用） */
  commandResult: CommandExecResult
  /** Realtime 语音列表（listRealtimeVoices 使用） */
  realtimeVoices: string[]

  // ─── UI 层后端数据 ──────────────────────────────────────
  /** 账户用量统计（AccountDialog 使用） */
  usageStats: UsageStat[]
  /** 聊天统计栏指标（ChatInput 使用） */
  chatStats: ChatStats
}

/**
 * 错误场景配置
 *
 * 定义 error 场景下哪些 API 应抛错，以及对应的错误信息。
 * shouldFail(apiName) 检查 apiName 是否在 failApis 中，
 * getMockError(apiName) 返回对应的 Error 实例。
 */
export interface ErrorScenarioConfig {
  /** 应抛错的 API 名称列表（与各文件 shouldFail 调用的参数对应） */
  failApis: string[]
  /** API 名称到错误信息的映射（未配置时使用默认错误信息） */
  errorMessages?: Record<string, string>
}
