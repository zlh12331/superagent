import {
  AppError,
  ErrorCode,
  MCP_COMMAND_PATTERN,
  MCP_SERVER_NAME_PATTERN,
} from '@code-agent/shared/main';

import { logger } from '../../../utils/logger';
import type { IToolRegistry } from '../tools/tool-registry';
import { MCPClient } from './mcp-client';
import { adaptMcpTool } from './mcp-tool-adapter';
import type { McpServerConfig, McpServerInfo, McpServerStatus } from './mcp-types';
import { buildMcpToolName, isMcpTool, resolveMcpTransport } from './mcp-types';

interface ServerEntry {
  readonly client: MCPClient;
  status: McpServerStatus;
  lastError?: string;
  toolNames: string[];
}

export interface IMCPService {
  startServer(config: McpServerConfig): Promise<void>;
  stopServer(name: string): Promise<void>;
  stopAll(): Promise<void>;
  listServers(): readonly McpServerInfo[];
  hasRunningServers(): boolean;
}

export class MCPService implements IMCPService {
  private readonly servers = new Map<string, ServerEntry>();

  constructor(private readonly toolRegistry: IToolRegistry) {}

  async startServer(config: McpServerConfig): Promise<void> {
    const { name } = config;

    if (this.servers.has(name)) {
      logger.warn({ serverName: name }, 'MCP server 已存在，先停止旧实例');
      await this.stopServer(name);
    }

    const client = new MCPClient(config);
    const entry: ServerEntry = {
      client,
      status: 'starting',
      toolNames: [],
    };
    this.servers.set(name, entry);

    try {
      await client.connect();

      const tools = client.listTools();
      const registeredNames: string[] = [];
      for (const descriptor of tools) {
        const adaptedTool = adaptMcpTool(config, descriptor, client.callTool);
        if (this.toolRegistry.get(adaptedTool.name) !== undefined) {
          logger.warn(
            { toolName: adaptedTool.name, serverName: name },
            'MCP 工具与已注册工具重名，跳过注册',
          );
          continue;
        }
        this.toolRegistry.register(adaptedTool);
        registeredNames.push(adaptedTool.name);
      }

      entry.toolNames = registeredNames;
      entry.status = 'running';
      logger.info(
        { serverName: name, toolCount: registeredNames.length },
        'MCP server 已启动并注册工具',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.status = 'error';
      entry.lastError = message;
      logger.error({ serverName: name, error: message }, 'MCP server 启动失败');
    }
  }

  async stopServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (entry === undefined) {
      return;
    }

    for (const toolName of entry.toolNames) {
      this.toolRegistry.unregister(toolName);
    }
    entry.toolNames = [];

    try {
      await entry.client.close();
      entry.status = entry.status === 'error' ? 'stopped_with_error' : 'stopped';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.status = 'stopped_with_error';
      entry.lastError = message;
      logger.warn({ serverName: name, error: message }, 'MCP server 关闭失败');
    }

    this.servers.delete(name);
  }

  async stopAll(): Promise<void> {
    const names = [...this.servers.keys()];
    if (names.length === 0) {
      return;
    }
    logger.info({ count: names.length }, '正在停止所有 MCP server');

    await Promise.allSettled(names.map((name) => this.stopServer(name)));
  }

  listServers(): readonly McpServerInfo[] {
    const infos: McpServerInfo[] = [];
    for (const [, entry] of this.servers) {
      const isConnected = entry.client.isConnected();
      const serverName = isConnected ? entry.client.getServerName() : undefined;
      const serverVersion = isConnected ? entry.client.getServerVersion() : undefined;
      infos.push({
        config: entry.client.getConfig(),
        status: entry.status,
        ...(entry.lastError !== undefined ? { lastError: entry.lastError } : {}),
        toolNames: [...entry.toolNames],
        ...(serverName !== undefined ? { serverName } : {}),
        ...(serverVersion !== undefined ? { serverVersion } : {}),
      });
    }
    return infos;
  }

  hasRunningServers(): boolean {
    for (const entry of this.servers.values()) {
      if (entry.status === 'running' || entry.status === 'starting') {
        return true;
      }
    }
    return false;
  }
}

export function isMcpToolName(toolName: string): boolean {
  return isMcpTool(toolName);
}

export function validateMcpServerConfig(
  config: McpServerConfig,
  existingToolNames?: ReadonlySet<string>,
): void {
  if (!config.name || config.name.length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'MCP server name 不能为空');
  }
  if (!MCP_SERVER_NAME_PATTERN.test(config.name)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'MCP server 名称仅允许字母/数字/下划线/连字符');
  }
  const transport = resolveMcpTransport(config);
  if (transport === 'stdio') {
    const command = config.command ?? '';
    if (command.length === 0) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `MCP server "${config.name}" 的 command 不能为空`,
      );
    }
    if (!MCP_COMMAND_PATTERN.test(command)) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `MCP server "${config.name}" 的 command 必须是裸可执行文件名（不含路径分隔符/空白/引号）`,
      );
    }
  } else {
    const url = config.url ?? '';
    let parsed: URL | undefined;
    try {
      parsed = url.length > 0 ? new URL(url) : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `MCP server "${config.name}" 的 ${transport} 传输需要合法的 http(s) url`,
      );
    }
  }
  if (existingToolNames?.has(config.name)) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `MCP server name "${config.name}" 与已注册工具重名`,
    );
  }
}

export { buildMcpToolName };
