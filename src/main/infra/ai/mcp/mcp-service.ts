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

/**
 * 单个 server 的运行时条目
 */
interface ServerEntry {
  /** MCPClient 实例 */
  readonly client: MCPClient;
  /** 当前状态 */
  status: McpServerStatus;
  /** 最近一次错误消息（status='error' 时有值） */
  lastError?: string;
  /** 已注册的工具名（含命名空间前缀） */
  toolNames: string[];
}

/**
 * MCPService 接口
 *
 * 解耦 ServiceContainer 对具体实现的依赖，便于：
 * - 单元测试：注入 mock 实现，不依赖真实子进程
 * - 实现替换：setMcpService 注入另一实现（工具注册表重建场景）
 */
export interface IMCPService {
  /** 启动单个 MCP server 并注册工具 */
  startServer(config: McpServerConfig): Promise<void>;
  /** 停止单个 MCP server 并注销工具 */
  stopServer(name: string): Promise<void>;
  /** 停止所有 MCP server（用于 dispose） */
  stopAll(): Promise<void>;
  /** 列出所有 server 的运行时状态 */
  listServers(): readonly McpServerInfo[];
  /** 是否有正在运行的 MCP server */
  hasRunningServers(): boolean;
}

/**
 * MCPService 默认实现
 *
 * 内部维护 Map<serverName, ServerEntry>，
 * 通过注入的 IToolRegistry 完成 MCP 工具的注册与注销。
 *
 * @example
 * ```ts
 * const mcpService = new MCPService(toolRegistry);
 * await mcpService.startServer({
 *   name: 'filesystem',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
 * });
 * // 现在工具 mcp__filesystem__read_file 等已注册到 ToolRegistry
 * await mcpService.stopServer('filesystem');
 * await mcpService.stopAll(); // 应用退出时
 * ```
 */
export class MCPService implements IMCPService {
  /** server 运行时条目 Map：serverName → ServerEntry */
  private readonly servers = new Map<string, ServerEntry>();

  /**
   * @param toolRegistry 工具注册表（用于注册/注销 MCP 工具）
   */
  constructor(private readonly toolRegistry: IToolRegistry) {}

  /** @inheritDoc */
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

  /** @inheritDoc */
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

  /** @inheritDoc */
  async stopAll(): Promise<void> {
    const names = [...this.servers.keys()];
    if (names.length === 0) {
      return;
    }
    logger.info({ count: names.length }, '正在停止所有 MCP server');

    await Promise.allSettled(names.map((name) => this.stopServer(name)));
  }

  /** @inheritDoc */
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

  /** @inheritDoc */
  hasRunningServers(): boolean {
    for (const entry of this.servers.values()) {
      if (entry.status === 'running' || entry.status === 'starting') {
        return true;
      }
    }
    return false;
  }
}

/**
 * 校验工具名是否为 MCP 工具（基于命名空间前缀）
 *
 * ⚠️ 当前无生产调用方（仅 barrel 导出与单测）——权限层的 MCP 防线直接用
 * mcp-types 的 isMcpTool（permission-service）；本函数是语义别名，供未来
 * 消费方与类型可达。保留属 knip exports 级人工审阅范畴。
 *
 * @param toolName 工具名
 * @returns 是否以 'mcp__' 开头
 */
export function isMcpToolName(toolName: string): boolean {
  return isMcpTool(toolName);
}

/**
 * 校验工具配置：name 不能为空、传输字段按 transport 分支校验
 *
 * 生产调用方 = mcp.handler（mcp:start 前校验，与本层 startServer 的运行时
 * 行为构成双重防线——此前该函数只被测试引用，生产路径裸奔，mcp.handler
 * 接线后闭合）。
 * - stdio：command 必填且为裸可执行文件名（P0 安全，与 shared MCP_COMMAND_PATTERN 同源）
 * - sse / streamable-http：url 必填且为 http(s) 地址
 *
 * @param config 待校验的 MCP server 配置
 * @param existingToolNames 已注册的工具名集合（用于重名检查）
 * @throws AppError(INVALID_INPUT) 当校验失败时
 */
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

/**
 * 根据工具名构建命名空间名称（暴露给外部使用，避免直接 import buildMcpToolName）
 */
export { buildMcpToolName };
