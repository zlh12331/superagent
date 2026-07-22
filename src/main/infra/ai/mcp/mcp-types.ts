// src/main/infra/ai/mcp/mcp-types.ts
// MCP（Model Context Protocol）类型定义
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 MCP server 配置类型（stdio 传输）
// - 定义工具命名空间 helper：避免与内置工具重名
// - 定义 MCP server 状态枚举
//
// 设计原则：
// - 仅支持 stdio 传输（最常见，npx/node 启动 MCP server）
//   HTTP/SSE 传输留待后续迭代
// - 工具命名空间：mcp__${serverName}__${toolName}（与 Claude Code 一致）
//   避免与内置工具（read_file 等）重名，且便于按 server 名批量过滤
// - MCP server 配置可由 settings store 持久化，运行时动态加载
// ──────────────────────────────────────────────────────────────

/**
 * MCP server 配置（stdio 传输）
 *
 * 与 @modelcontextprotocol/sdk 的 StdioServerParameters 对齐，
 * 额外增加 name 字段作为 server 唯一标识（用于工具命名空间与日志追踪）。
 *
 * @example
 * ```ts
 * const config: McpServerConfig = {
 *   name: 'filesystem',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed'],
 *   env: { NODE_ENV: 'production' },
 * };
 * ```
 */
export interface McpServerConfig {
  /** server 唯一名称（用于工具命名空间 mcp__${name}__${tool}） */
  readonly name: string;
  /** 启动 MCP server 的命令（如 'npx' / 'node'） */
  readonly command: string;
  /** 命令行参数 */
  readonly args?: readonly string[];
  /** 环境变量（覆盖进程默认 env） */
  readonly env?: Readonly<Record<string, string>>;
  /** 子进程工作目录（默认继承父进程） */
  readonly cwd?: string;
  /**
   * 工具权限覆盖（可选）
   *
   * 默认行为：
   * - annotations.readOnlyHint=true → 'auto'
   * - 否则 → 'ask'（安全默认，未知工具默认询问）
   *
   * 此字段允许用户强制覆盖默认权限决策。
   */
  readonly permissionOverride?: 'auto' | 'ask';
}

/**
 * MCP server 运行时状态
 */
export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopped_with_error';

/**
 * MCP server 运行时信息（由 MCPService 维护）
 */
export interface McpServerInfo {
  /** server 配置（不可变快照） */
  readonly config: McpServerConfig;
  /** 当前状态 */
  readonly status: McpServerStatus;
  /** 最近一次错误消息（status='error' 时有值） */
  readonly lastError?: string;
  /** 已注册的工具名（含命名空间前缀，如 mcp__filesystem__read_file） */
  readonly toolNames: readonly string[];
  /** server 报告的名称（capabilities 协商时获得） */
  readonly serverName?: string;
  /** server 报告的版本 */
  readonly serverVersion?: string;
}

/**
 * 工具命名空间前缀
 *
 * 用于隔离 MCP 工具与内置工具，避免重名冲突。
 * 格式：mcp__${serverName}__
 */
const MCP_TOOL_PREFIX = 'mcp__';

/**
 * 构建 MCP 工具的命名空间名称
 *
 * @param serverName MCP server 名称
 * @param toolName MCP server 返回的工具名
 * @returns 命名空间后的工具名（如 'mcp__filesystem__read_file'）
 *
 * @example
 * ```ts
 * buildMcpToolName('filesystem', 'read_file'); // 'mcp__filesystem__read_file'
 * ```
 */
export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

/**
 * 判断工具名是否为 MCP 工具
 *
 * @param toolName 工具名
 * @returns 是否以 'mcp__' 开头
 */
export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

/**
 * 从命名空间工具名解析出原始 MCP 工具名
 *
 * @param namespacedToolName 命名空间后的工具名（如 'mcp__filesystem__read_file'）
 * @returns { serverName, toolName } 或 undefined（格式不匹配）
 *
 * @example
 * ```ts
 * parseMcpToolName('mcp__filesystem__read_file');
 * // { serverName: 'filesystem', toolName: 'read_file' }
 * ```
 */
export function parseMcpToolName(
  namespacedToolName: string,
): { serverName: string; toolName: string } | undefined {
  if (!namespacedToolName.startsWith(MCP_TOOL_PREFIX)) {
    return undefined;
  }
  const rest = namespacedToolName.slice(MCP_TOOL_PREFIX.length);
  const sepIdx = rest.indexOf('__');
  if (sepIdx <= 0 || sepIdx >= rest.length - 2) {
    return undefined;
  }
  return {
    serverName: rest.slice(0, sepIdx),
    toolName: rest.slice(sepIdx + 2),
  };
}
