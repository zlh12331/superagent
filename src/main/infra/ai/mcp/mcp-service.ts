// src/main/infra/ai/mcp/mcp-service.ts
// MCPService：管理多个 MCP server 的连接 + 工具注册
// ──────────────────────────────────────────────────────────────
// 职责：
// - startServer(config)：启动单个 MCP server，把工具注册到 ToolRegistry
// - stopServer(name)：停止 MCP server，从 ToolRegistry 注销工具
// - stopAll()：停止所有 MCP server（用于 dispose）
// - listServers()：返回所有 server 的运行时状态
// - updateConfig(configs)：批量更新配置（diff 后增量启动/停止）
//
// 设计原则：
// - 单例模式：通过 ServiceContainer 持有，整个应用生命周期共享一个实例
// - 错误隔离：单个 server 启动失败不影响其他 server
// - 工具命名空间：所有 MCP 工具名以 mcp__ 开头，便于按 server 名批量过滤
// - 状态追踪：维护 serverName → { client, status, toolNames } 的 Map
// ──────────────────────────────────────────────────────────────

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
import { buildMcpToolName, isMcpTool } from './mcp-types';

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
 * - 未来扩展：支持 HTTP/SSE 传输等
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

    // 重名校验：同名 server 已存在时先停止旧的
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
      // 启动 MCP server 并完成握手
      await client.connect();

      // 把 server 的工具注册到 ToolRegistry
      const tools = client.listTools();
      const registeredNames: string[] = [];
      for (const descriptor of tools) {
        const adaptedTool = adaptMcpTool(config, descriptor, client.callTool);
        // 重名保护：若同名工具已注册（如多个 MCP server 工具冲突），跳过并 warn
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
      // 启动失败：保留 entry 以记录错误状态，便于 listServers 排查
      const message = error instanceof Error ? error.message : String(error);
      entry.status = 'error';
      entry.lastError = message;
      logger.error({ serverName: name, error: message }, 'MCP server 启动失败');
      // 不重新抛出：单个 server 失败不应阻断其他 server 启动
      // 调用方可通过 listServers() 查看状态，决定是否重试
    }
  }

  /** @inheritDoc */
  async stopServer(name: string): Promise<void> {
    const entry = this.servers.get(name);
    if (entry === undefined) {
      // 静默忽略未注册的 server（幂等）
      return;
    }

    // 1. 从 ToolRegistry 注销此 server 注册的所有工具
    for (const toolName of entry.toolNames) {
      this.toolRegistry.unregister(toolName);
    }
    entry.toolNames = [];

    // 2. 关闭 MCP client（终止子进程）
    try {
      await entry.client.close();
      entry.status = entry.status === 'error' ? 'stopped_with_error' : 'stopped';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      entry.status = 'stopped_with_error';
      entry.lastError = message;
      logger.warn({ serverName: name, error: message }, 'MCP server 关闭失败');
    }

    // 3. 从 Map 移除（停止后不再追踪）
    this.servers.delete(name);
  }

  /** @inheritDoc */
  async stopAll(): Promise<void> {
    const names = [...this.servers.keys()];
    if (names.length === 0) {
      return;
    }
    logger.info({ count: names.length }, '正在停止所有 MCP server');

    // 并行停止所有 server（每个 server 关闭互不影响）
    await Promise.allSettled(names.map((name) => this.stopServer(name)));
  }

  /** @inheritDoc */
  listServers(): readonly McpServerInfo[] {
    const infos: McpServerInfo[] = [];
    for (const [, entry] of this.servers) {
      // L2 修复：显式检查 client 连接状态后再读取 server 元数据
      // - startServer 失败时 entry 保留在 Map（status='error'），但 client 已通过 closeQuietly 断开
      // - 此时 getServerName/Version 虽不会抛错（仅返回 undefined），但显式检查避免依赖隐式约定
      // - 也为未来 SDK 升级留出防御空间（新版本可能在断开后抛错）
      const isConnected = entry.client.isConnected();
      const serverName = isConnected ? entry.client.getServerName() : undefined;
      const serverVersion = isConnected ? entry.client.getServerVersion() : undefined;
      // 注意：exactOptionalPropertyTypes 下，可选属性不能显式赋 undefined，
      // 必须用条件展开（仅当值存在时才写入属性）
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
 * 暴露给 ToolExecutor / AgentService 使用，用于按需过滤 MCP 工具。
 *
 * @param toolName 工具名
 * @returns 是否以 'mcp__' 开头
 */
export function isMcpToolName(toolName: string): boolean {
  return isMcpTool(toolName);
}

/**
 * 校验工具配置：name 不能为空、不能与内置工具重名
 *
 * 在 startServer 前调用，提前拦截非法配置。
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
  // 名称字符集约束：name 参与工具命名空间（mcp__name__tool），非法字符破坏命名空间解析
  if (!MCP_SERVER_NAME_PATTERN.test(config.name)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'MCP server 名称仅允许字母/数字/下划线/连字符');
  }
  if (!config.command || config.command.length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, `MCP server "${config.name}" 的 command 不能为空`);
  }
  // P0 安全：command 必须是裸可执行文件名（无路径分隔符/空白/引号），
  // 阻断绝对路径/路径穿越/多段命令注入（与 shared MCP_COMMAND_PATTERN 同源，纵深防御）
  if (!MCP_COMMAND_PATTERN.test(config.command)) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `MCP server "${config.name}" 的 command 必须是裸可执行文件名（不含路径分隔符/空白/引号）`,
    );
  }
  // 重名保护：server name 不能与现有工具重名（避免 mcp__name__xxx 与现有工具冲突）
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
