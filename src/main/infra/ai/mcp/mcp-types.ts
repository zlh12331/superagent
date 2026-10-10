// mcp-types.ts：MCP 配置/状态类型与工具命名规则（前缀 mcp__ 防与内置工具撞名）
/** MCP 传输三型：stdio=子进程 / sse、streamable-http=远端 HTTP */
export type McpTransportType = 'stdio' | 'sse' | 'streamable-http';

/** server 配置（stdio 走 command/args/env，远端走 url/headers；permissionOverride 覆盖默认审批） */
export interface McpServerConfig {
  readonly name: string;
  readonly transport?: McpTransportType;
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly permissionOverride?: 'auto' | 'ask';
}

export function resolveMcpTransport(config: Pick<McpServerConfig, 'transport'>): McpTransportType {
  return config.transport ?? 'stdio';
}

export type McpServerStatus = 'stopped' | 'starting' | 'running' | 'error' | 'stopped_with_error';

export interface McpServerInfo {
  readonly config: McpServerConfig;
  readonly status: McpServerStatus;
  readonly lastError?: string;
  readonly toolNames: readonly string[];
  readonly serverName?: string;
  readonly serverVersion?: string;
}

const MCP_TOOL_PREFIX = 'mcp__';

export function buildMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${toolName}`;
}

export function isMcpTool(toolName: string): boolean {
  return toolName.startsWith(MCP_TOOL_PREFIX);
}

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
