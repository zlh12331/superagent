/**
 * Codex API — MCP (Model Context Protocol) 域
 *
 * MCP server 管理：列出、添加、删除、列出工具、调用工具、
 * 列出资源、读取资源、刷新服务器以及事件监听。
 *
 * 后端命令已实现（5 个 Tauri command）：
 * - mcp_server_oauth_login — 启动 MCP 服务器 OAuth 登录流程
 * - mcp_server_status_list — 分页列出 MCP 服务器状态
 * - mcp_resource_read — 读取 MCP 资源内容
 * - mcp_server_tool_call — 调用 MCP 服务器工具
 * - mcp_server_refresh — 刷新 MCP 服务器配置
 *
 * 所有命令返回 JSON 字符串（避免 specta 递归类型栈溢出），
 * 前端调用后 `JSON.parse()` 得到结构化数据。
 *
 * @see src/lib/tauri-bindings.ts — tauri-specta 自动生成的类型安全调用
 * @see src/lib/bindings.ts — tauri-specta 自动生成的类型定义
 * @see src/lib/codex/types.ts — McpServer, McpTool, McpResource, McpToolCallResult 类型
 */

import type { UnlistenFn } from '@tauri-apps/api/event'
import { commands } from '@/lib/tauri-bindings'
import type {
  McpServerOauthLoginArgs_Deserialize,
  McpServerStatusListArgs_Deserialize,
  McpResourceReadArgs_Deserialize,
  McpServerToolCallArgs_Deserialize,
  McpServerRefreshArgs,
} from '@/lib/bindings'
import type {
  McpServer,
  McpTool,
  McpResource,
  McpToolCallResult,
} from './types'
import { isTauri } from '@/lib/env'
// 集中式 mock 模块 — 浏览器开发模式的 MCP 数据与统一事件监听
import { getMockData, shouldFail, getMockError, universalListen } from './mock'

// ---------------------------------------------------------------------------
// Tauri 响应类型与适配器
// ---------------------------------------------------------------------------

/** mcpServerStatus/list 响应中的单个服务器状态条目 */
interface McpServerStatusEntry {
  /** MCP 服务器名称（后端以此作为唯一标识） */
  name: string
  /** 传输方式：stdio / sse / websocket */
  transport?: string
  /** stdio 模式下启动命令 */
  command?: string | null
  /** stdio 模式下命令参数 */
  args?: string[]
  /** 环境变量 */
  env?: Record<string, string>
  /** 连接状态：connected / disconnected / error */
  status?: string
  /** 已注册工具数量 */
  tools?: number
  /** 已注册资源数量 */
  resources?: number
  /** 错误信息（status 为 error 时） */
  error?: string | null
}

/** mcpServerStatus/list 响应的 JSON 结构 */
interface McpServerStatusListResponse {
  /** 服务器状态列表 */
  servers: McpServerStatusEntry[]
  /** 分页游标（下一页起点，为空表示已到末尾） */
  nextCursor?: string | null
}

/** mcpServer/tool/call 响应的 JSON 结构（对齐 MCP 协议 CallToolResult） */
interface McpServerToolCallResponse {
  /** 工具返回内容数组 */
  content: { type: string; text: string }[]
  /** 是否为错误返回 */
  isError: boolean
}

/** mcpServer/resource/read 响应的 JSON 结构 */
interface McpResourceReadResponse {
  /** 资源内容数组 */
  contents: { uri: string; mimeType?: string | null; text: string }[]
}

/** mcpServer/oauth/login 响应的 JSON 结构 */
interface McpServerOauthLoginResponse {
  /** 登录会话 ID */
  loginId: string
  /** OAuth 授权 URL（前端在浏览器中打开） */
  authUrl: string
}

/**
 * 将后端返回的 MCP 服务器状态条目转换为前端 McpServer 类型。
 *
 * 后端以 `name` 作为服务器唯一标识，前端 McpServer.id 直接使用 name。
 */
function adaptMcpServer(raw: McpServerStatusEntry): McpServer {
  return {
    id: raw.name,
    name: raw.name,
    transport: (raw.transport as McpServer['transport']) ?? 'stdio',
    command: raw.command ?? null,
    args: raw.args ?? [],
    env: raw.env ?? {},
    status: (raw.status as McpServer['status']) ?? 'disconnected',
    tools: raw.tools ?? 0,
    resources: raw.resources ?? 0,
    error: raw.error ?? null,
  }
}

// ---------------------------------------------------------------------------
// API 函数
// ---------------------------------------------------------------------------

/**
 * 列出已注册的 MCP 服务器。
 *
 * Tauri 模式调用 `mcpServerStatus/list` 命令（支持分页），
 * 浏览器模式返回 mock 数据。
 *
 * @param cursor — 分页游标（Tauri 模式，上一次返回的 nextCursor）
 * @param limit — 每页数量（Tauri 模式）
 * @param threadId — 关联的线程 ID（为空时使用全局作用域）
 */
export async function listMcpServers(
  cursor?: string | null,
  limit?: number | null,
  threadId?: string | null
): Promise<McpServer[]> {
  if (isTauri()) {
    const args: McpServerStatusListArgs_Deserialize = {
      cursor: cursor ?? null,
      limit: limit ?? null,
      threadId: threadId ?? null,
    }
    const result = await commands.mcpServerStatusList(args)
    if (result.status === 'error') {
      throw new Error(`mcpServerStatus/list failed: ${result.error.message}`)
    }
    const parsed: McpServerStatusListResponse = JSON.parse(result.data)
    return parsed.servers.map(adaptMcpServer)
  }

  // 浏览器开发模式 — error 场景按配置抛错，否则返回 mock 数据
  if (shouldFail('listMcpServers')) {
    throw getMockError('listMcpServers')
  }
  return getMockData().mcpServers
}

/**
 * 添加新的 MCP server。
 *
 * 后端尚未实现此命令。
 * - Tauri 模式：抛错，避免返回 mock 假数据掩盖真实故障
 * - 浏览器开发模式：返回 mock 数据（tools/resources/error 初始化为 0/0/null）
 *
 * 调用方只需提供名称、传输方式、命令、参数、环境变量。
 */
export async function addMcpServer(
  server: Omit<McpServer, 'id' | 'status' | 'tools' | 'resources' | 'error'>
): Promise<McpServer> {
  if (isTauri()) {
    // 后端尚未实现添加 MCP 服务器的命令
    // 抛错而非返回 mock 数据，避免生产环境显示假数据掩盖真实故障
    throw new Error('addMcpServer not implemented in backend')
  }
  return {
    ...server,
    id: `mcp-${Date.now()}`,
    status: 'disconnected',
    tools: 0,
    resources: 0,
    error: null,
  }
}

/**
 * 删除 MCP server。
 *
 * 后端尚未实现此命令。
 * - Tauri 模式：抛错，避免静默 no-op 掩盖真实故障
 * - 浏览器开发模式：no-op
 */
export async function removeMcpServer(_serverId: string): Promise<void> {
  if (isTauri()) {
    // 后端尚未实现删除 MCP 服务器的命令
    // 抛错而非静默 no-op，避免生产环境误以为删除成功
    throw new Error('removeMcpServer not implemented in backend')
  }
  // 浏览器开发模式 — no-op
}

/**
 * 列出 MCP server 提供的工具。
 *
 * 后端尚未实现此命令。
 * - Tauri 模式：抛错，避免返回 mock 假数据掩盖真实故障
 * - 浏览器开发模式：返回 mock 数据
 *
 * @param serverId — MCP 服务器 ID
 */
export async function listMcpTools(serverId: string): Promise<McpTool[]> {
  if (isTauri()) {
    // 后端尚未实现列出 MCP 工具的命令
    // 抛错而非返回 mock 数据，避免生产环境显示假数据掩盖真实故障
    throw new Error('listMcpTools not implemented in backend')
  }
  return getMockData().mcpTools.filter(t => t.serverId === serverId)
}

/**
 * 列出 MCP server 提供的资源。
 *
 * 后端尚未实现此命令。
 * - Tauri 模式：抛错，避免返回 mock 假数据掩盖真实故障
 * - 浏览器开发模式：返回 mock 数据
 *
 * @param serverId — MCP 服务器 ID
 */
export async function listMcpResources(
  serverId: string
): Promise<McpResource[]> {
  if (isTauri()) {
    // 后端尚未实现列出 MCP 资源的命令
    // 抛错而非返回 mock 数据，避免生产环境显示假数据掩盖真实故障
    throw new Error('listMcpResources not implemented in backend')
  }
  return getMockData().mcpResources.filter(r => r.serverId === serverId)
}

/**
 * 调用 MCP 服务器工具。
 *
 * Tauri 模式调用 `mcpServer/tool/call` 命令，
 * 浏览器模式返回 mock 数据。
 *
 * @param serverId — MCP 服务器名称（后端以 name 作为标识）
 * @param toolName — 要调用的工具名称
 * @param args — 工具调用参数对象（前端自动 JSON.stringify 后传给后端）
 * @param threadId — 关联的线程 ID（Tauri 模式必填，浏览器模式忽略）
 * @returns 工具调用结果（对齐 MCP 协议 CallToolResult）
 */
export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  threadId?: string
): Promise<McpToolCallResult> {
  if (isTauri()) {
    const callArgs: McpServerToolCallArgs_Deserialize = {
      threadId: threadId ?? '',
      server: serverId,
      tool: toolName,
      // specta BigInt 限制：arguments 必须是 JSON 字符串而非对象
      arguments: JSON.stringify(args),
    }
    const result = await commands.mcpServerToolCall(callArgs)
    if (result.status === 'error') {
      throw new Error(`mcpServer/tool/call failed: ${result.error.message}`)
    }
    const parsed: McpServerToolCallResponse = JSON.parse(result.data)
    // 前端 McpToolCallResult 仅支持 text 类型，统一映射
    return {
      content: parsed.content.map(c => ({
        type: 'text' as const,
        text: c.text,
      })),
      isError: parsed.isError,
    }
  }

  // 浏览器开发模式 — 返回 mock 数据
  return {
    content: [{ type: 'text', text: 'mock tool output' }],
    isError: false,
  }
}

/**
 * 读取 MCP 资源内容。
 *
 * Tauri 模式调用 `mcpServer/resource/read` 命令，
 * 浏览器模式返回 mock 文本。
 *
 * @param serverId — MCP 服务器名称（后端以 name 作为标识）
 * @param uri — 资源 URI
 * @param threadId — 关联的线程 ID（为空时使用全局作用域）
 * @returns 资源文本内容（多个 contents 以换行拼接）
 */
export async function readMcpResource(
  serverId: string,
  uri: string,
  threadId?: string | null
): Promise<string> {
  if (isTauri()) {
    const args: McpResourceReadArgs_Deserialize = {
      threadId: threadId ?? null,
      server: serverId,
      uri,
    }
    const result = await commands.mcpResourceRead(args)
    if (result.status === 'error') {
      throw new Error(`mcpServer/resource/read failed: ${result.error.message}`)
    }
    const parsed: McpResourceReadResponse = JSON.parse(result.data)
    // 多个 contents 以换行拼接为单个文本
    return parsed.contents.map(c => c.text).join('\n')
  }

  // 浏览器开发模式 — 返回 mock 文本
  return '# 示例资源内容\n\n这是一个 MCP 资源的 mock 内容。'
}

/**
 * 刷新 MCP 服务器配置。
 *
 * Tauri 模式调用 `mcpServer/refresh` 命令（重新加载所有已注册服务器），
 * 浏览器模式为 no-op。
 *
 * 注意：后端命令无参数，会刷新全部服务器而非单个服务器。
 * `serverId` 参数仅用于浏览器 mock 模式的前端兼容。
 *
 * @param _serverId — 保留参数（后端刷新全部服务器，不按名称筛选）
 */
export async function refreshMcpServer(_serverId: string): Promise<void> {
  if (isTauri()) {
    // McpServerRefreshArgs 为空对象（Record<string, never>）
    const args: McpServerRefreshArgs = {}
    const result = await commands.mcpServerRefresh(args)
    if (result.status === 'error') {
      throw new Error(`mcpServer/refresh failed: ${result.error.message}`)
    }
    return
  }

  // 浏览器开发模式 — no-op
}

/**
 * 启动 MCP 服务器的 OAuth 登录流程。
 *
 * Tauri 模式调用 `mcpServer/oauth/login` 命令，
 * 浏览器模式返回 mock 数据。
 *
 * @param name — MCP 服务器名称
 * @param threadId — 关联的线程 ID（为空时使用全局作用域）
 * @param scopes — OAuth 授权范围列表
 * @param timeoutSecs — 登录超时时间（秒）
 * @returns OAuth 登录信息（loginId 和 authUrl）
 */
export async function loginMcpServerOAuth(
  name: string,
  threadId?: string | null,
  scopes?: string[] | null,
  timeoutSecs?: number | null
): Promise<{ loginId: string; authUrl: string }> {
  if (isTauri()) {
    const args: McpServerOauthLoginArgs_Deserialize = {
      name,
      threadId: threadId ?? null,
      scopes: scopes ?? null,
      timeoutSecs: timeoutSecs ?? null,
    }
    const result = await commands.mcpServerOauthLogin(args)
    if (result.status === 'error') {
      throw new Error(`mcpServer/oauth/login failed: ${result.error.message}`)
    }
    const parsed: McpServerOauthLoginResponse = JSON.parse(result.data)
    return {
      loginId: parsed.loginId,
      authUrl: parsed.authUrl,
    }
  }

  // 浏览器开发模式 — 返回 mock 数据
  return {
    loginId: `mcp-oauth-${Date.now()}`,
    authUrl: 'https://example.com/oauth/authorize',
  }
}

// ─── Task 20: 事件监听 ──────────────────────────────────────────

/**
 * 监听 MCP 服务器启动状态更新（mcpServer/startupStatus/updated）。
 *
 * Tauri 环境下注册事件监听器；浏览器 / 测试环境下返回空 unlisten，
 * 调用方可安全地在 cleanup 中直接调用返回的函数。
 */
export async function onMcpServerStatusUpdated(
  callback: () => void
): Promise<UnlistenFn> {
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return universalListen('mcpServer/startupStatus/updated', callback)
}

/**
 * 监听 MCP 工具调用进度（item/mcpToolCall/progress）。
 *
 * Tauri 环境下注册事件监听器；浏览器 / 测试环境下返回空 unlisten。
 */
export async function onMcpToolCallProgress(
  callback: (progress: { message: string }) => void
): Promise<UnlistenFn> {
  // 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
  return universalListen<{ message: string }>(
    'item/mcpToolCall/progress',
    callback
  )
}
