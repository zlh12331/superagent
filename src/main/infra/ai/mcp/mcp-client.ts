// src/main/infra/ai/mcp/mcp-client.ts
// MCPClient：单个 MCP server 的客户端封装
// ──────────────────────────────────────────────────────────────
// 职责：
// - 按配置创建传输层（stdio 子进程 / sse / streamable-http 远程 HTTP）
// - 完成 MCP 协议初始化握手（capabilities 协商）
// - listTools：获取 server 提供的工具列表
// - callTool：转发工具调用到 MCP server
// - close：关闭连接 + 终止子进程（stdio）
//
// 设计原则：
// - 单 server 单 client：每个 McpServerConfig 对应一个 MCPClient 实例
// - 错误隔离：单个 server 启动失败不影响其他 server
// - 日志追踪：所有关键操作打 log（含 serverName 便于排查）
// - 传输创建收敛在 createMcpTransport：按 resolveMcpTransport 分支，便于测试
// ──────────────────────────────────────────────────────────────

import { AppError, ErrorCode } from '@code-agent/shared/main';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { logger } from '../../../utils/logger';
import type { McpCallToolFn, McpToolCallResult, McpToolDescriptor } from './mcp-tool-adapter';
import type { McpServerConfig } from './mcp-types';
import { resolveMcpTransport } from './mcp-types';

/**
 * 按配置创建传输层实例
 *
 * - stdio：StdioClientTransport（启动本地子进程；stderr pipe 到日志由调用方处理）
 * - sse：SSEClientTransport（HTTP 轮询降级通道）
 * - streamable-http：StreamableHTTPClientTransport（现代远程传输）
 *
 * 远程传输通过 requestInit.headers 注入授权头（如 Authorization）。
 *
 * 返回具体类联合而非 SDK Transport 接口：SDK 的 StreamableHTTPClientTransport
 * 在 exactOptionalPropertyTypes 下与自身 Transport 接口不结构兼容（sessionId 可选性），
 * 具体联合可保留类型信息，connect 处按需断言。
 *
 * @param config MCP server 配置（transport 缺省 stdio）
 */
export function createMcpTransport(config: McpServerConfig): McpTransportInstance {
  const transport = resolveMcpTransport(config);
  if (transport === 'stdio') {
    // exactOptionalPropertyTypes 下，可选属性不能显式赋 undefined，
    // 必须用条件展开（仅当值存在时才写入属性）
    return new StdioClientTransport({
      command: config.command ?? '',
      ...(config.args !== undefined ? { args: [...config.args] } : {}),
      ...(config.env !== undefined ? { env: { ...config.env } } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      // 把 stderr pipe 到日志（避免 server 日志污染主进程 stderr）
      stderr: 'pipe',
    });
  }
  // 远程 transport：url 必填（schema + validateMcpServerConfig 已保证，防御性兜底）
  if (config.url === undefined || config.url.length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, `MCP server "${config.name}" 缺少 url 配置`);
  }
  const url = new URL(config.url);
  const requestInit: RequestInit | undefined =
    config.headers !== undefined ? { headers: { ...config.headers } } : undefined;
  if (transport === 'sse') {
    return new SSEClientTransport(url, ...(requestInit !== undefined ? [{ requestInit }] : []));
  }
  return new StreamableHTTPClientTransport(
    url,
    ...(requestInit !== undefined ? [{ requestInit }] : []),
  );
}

/** MCPClient 支持的传输实例联合 */
export type McpTransportInstance =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport;

/**
 * MCPClient：管理与单个 MCP server 的连接
 *
 * 生命周期：
 * 1. new MCPClient(config)：创建实例（未连接）
 * 2. connect()：启动子进程 + 完成 MCP 握手 + 缓存工具列表
 * 3. listTools()：返回缓存的工具描述（不重复请求 server）
 * 4. callTool(toolName, input)：转发工具调用
 * 5. close()：关闭连接 + 终止子进程
 *
 * 错误处理：
 * - connect 失败：抛 AppError(INTERNAL_ERROR)，调用方负责状态更新
 * - callTool 失败：抛 AppError(TOOL_EXECUTION_FAILED)，由 ToolExecutor 捕获
 * - close 失败：仅 log warn，不抛错（避免 dispose 路径中断）
 *
 * @example
 * ```ts
 * const client = new MCPClient({
 *   name: 'filesystem',
 *   command: 'npx',
 *   args: ['-y', '@modelcontextprotocol/server-filesystem', '/path'],
 * });
 * await client.connect();
 * const tools = client.listTools();
 * const result = await client.callTool('read_file', { path: '/tmp/test.txt' });
 * await client.close();
 * ```
 */
export class MCPClient {
  /** MCP SDK Client 实例（connect 后创建） */
  private client: Client | null = null;
  /** 传输实例（connect 后创建；stdio=StdioClientTransport / 远程=SSE/StreamableHTTP） */
  private transport: McpTransportInstance | null = null;
  /** 缓存的工具描述（connect 时一次性拉取，避免每次 listTools 都请求 server） */
  private cachedTools: readonly McpToolDescriptor[] = [];
  /** server 报告的名称（capabilities 协商时获得） */
  private serverName: string | undefined;
  /** server 报告的版本 */
  private serverVersion: string | undefined;
  /** 是否已连接（避免重复 connect / close） */
  private connected = false;

  /**
   * @param config MCP server 配置
   */
  constructor(private readonly config: McpServerConfig) {}

  /**
   * 启动 MCP server 子进程并完成协议握手
   *
   * 步骤：
   * 1. 创建 StdioClientTransport（启动子进程）
   * 2. 创建 Client + 调用 connect() 完成 MCP 握手
   * 3. 调用 listTools 缓存工具列表
   *
   * 幂等性：已连接时直接返回，不重复启动
   *
   * @throws AppError(INTERNAL_ERROR) 当启动或握手失败时
   */
  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const { name } = this.config;
    const transportKind = resolveMcpTransport(this.config);
    logger.info(
      {
        serverName: name,
        transport: transportKind,
        ...(transportKind === 'stdio'
          ? { command: this.config.command, args: this.config.args }
          : { url: this.config.url }),
      },
      '正在启动 MCP server',
    );

    try {
      // 1. 创建传输层（stdio 子进程 / sse / streamable-http）
      this.transport = createMcpTransport(this.config);

      // stdio：监听子进程 stderr，转写到日志（debug 级别；远程传输无 stderr）
      if (transportKind === 'stdio') {
        // 配置已收敛为 stdio 分支，断言取回 Stdio 专有 stderr 流
        const stderrStream = (this.transport as StdioClientTransport).stderr;
        if (stderrStream !== null && typeof (stderrStream as { on?: unknown }).on === 'function') {
          const stream = stderrStream as {
            on: (event: string, cb: (chunk: Buffer) => void) => void;
          };
          stream.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8').trim();
            if (text.length > 0) {
              logger.debug({ serverName: name, stderr: text }, 'MCP server stderr');
            }
          });
        }
      }

      // 2. 创建 MCP Client 并连接
      this.client = new Client(
        { name: 'code-agent-agent', version: '0.1.0' },
        { capabilities: {} },
      );
      // 断言为 SDK Transport：StreamableHTTPClientTransport 在 exactOptionalPropertyTypes
      // 下与自身接口不结构兼容（sessionId 可选性），运行时行为符合接口契约
      await this.client.connect(this.transport as Transport);

      // 3. 缓存 server 元数据
      const serverInfo = this.client.getServerVersion();
      this.serverName = serverInfo?.name;
      this.serverVersion = serverInfo?.version;

      // 4. 拉取并缓存工具列表
      // 注意：exactOptionalPropertyTypes 下，description/annotations 为可选属性，
      // 不能显式赋 undefined，需用条件展开
      const toolsResult = await this.client.listTools();
      this.cachedTools = toolsResult.tools.map(
        (tool): McpToolDescriptor => ({
          name: tool.name,
          ...(tool.description !== undefined ? { description: tool.description } : {}),
          inputSchema: tool.inputSchema as McpToolDescriptor['inputSchema'],
          ...(tool.annotations !== undefined
            ? {
                annotations: tool.annotations as NonNullable<McpToolDescriptor['annotations']>,
              }
            : {}),
        }),
      );

      this.connected = true;
      logger.info(
        {
          serverName: name,
          serverImpl: this.serverName,
          serverVersion: this.serverVersion,
          toolCount: this.cachedTools.length,
        },
        'MCP server 已连接',
      );
    } catch (error) {
      // 启动失败：清理已创建的资源
      await this.closeQuietly();
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ serverName: name, error: message }, 'MCP server 启动失败');
      throw new AppError(ErrorCode.INTERNAL_ERROR, `MCP server "${name}" 启动失败：${message}`, {
        cause: error,
      });
    }
  }

  /**
   * 返回缓存的工具描述列表
   *
   * 不再请求 server（connect 时已缓存），避免每次对话都拉取。
   * 若 server 工具列表变化，需调用 reconnect() 重新拉取。
   *
   * @returns 工具描述数组（不可变）
   * @throws AppError(INTERNAL_ERROR) 当未连接时
   */
  listTools(): readonly McpToolDescriptor[] {
    if (!this.connected) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `MCP server "${this.config.name}" 未连接，无法列出工具`,
      );
    }
    return this.cachedTools;
  }

  /**
   * 转发工具调用到 MCP server
   *
   * 实现 McpCallToolFn 接口，供 adaptMcpTool 注入。
   * 内部调用 MCP SDK 的 client.callTool，把结果转换为 McpToolCallResult。
   *
   * abortSignal 支持（M1 修复）：把 ctx.abortSignal 透传到 MCP SDK 的 RequestOptions.signal，
   * SDK 在 abort 触发时会向 server 发送 cancellation notification 并抛出 AbortError。
   * 这样用户中断对话时，长时间运行的 MCP 工具能及时被取消。
   *
   * @param toolName 工具名（不含命名空间前缀）
   * @param input 工具入参
   * @param ctx 工具执行上下文（提供 abortSignal，用于中断长时间运行的 MCP 工具）
   * @returns MCP server 返回的工具结果
   *
   * @throws AppError(TOOL_EXECUTION_FAILED) 当调用失败时
   * @throws AppError(TOOL_ABORTED) 当用户中断时
   * @throws AppError(INTERNAL_ERROR) 当未连接时
   */
  callTool: McpCallToolFn = async (
    toolName: string,
    input: unknown,
    ctx: Parameters<McpCallToolFn>[2],
  ): Promise<McpToolCallResult> => {
    if (!this.connected || this.client === null) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `MCP server "${this.config.name}" 未连接，无法调用工具 ${toolName}`,
      );
    }

    // 调用前再次检查 abortSignal（避免无效请求）
    if (ctx.abortSignal.aborted) {
      throw new AppError(ErrorCode.TOOL_ABORTED, `MCP 工具已中断：${toolName}`);
    }

    try {
      // 把 ctx.abortSignal 透传到 MCP SDK 的 RequestOptions.signal（M1 修复）
      // SDK 在 abort 触发时会向 server 发送 cancellation notification 并抛出 AbortError
      const result = await this.client.callTool(
        {
          name: toolName,
          arguments: input as Record<string, unknown> | undefined,
        },
        undefined,
        { signal: ctx.abortSignal },
      );

      // 转换 MCP SDK 返回结构为 McpToolCallResult
      // 注意：result.isError 在 MCP SDK 中因 $loose catchall 推断为 unknown，
      // 此处断言为 boolean | undefined（Zod schema 已保证运行时类型）
      return {
        content: (result.content ?? []) as McpToolCallResult['content'],
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError as boolean } : {}),
      };
    } catch (error) {
      // abort 触发的 AbortError 转换为 TOOL_ABORTED（与内置工具一致）
      const isAborted =
        ctx.abortSignal.aborted || (error instanceof Error && error.name === 'AbortError');
      if (isAborted) {
        throw new AppError(ErrorCode.TOOL_ABORTED, `MCP 工具已中断：${toolName}`);
      }
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ serverName: this.config.name, toolName, error: message }, 'MCP 工具调用失败');
      throw new AppError(
        ErrorCode.TOOL_EXECUTION_FAILED,
        `MCP 工具 ${toolName} 调用失败：${message}`,
        { cause: error },
      );
    }
  };

  /**
   * 关闭连接并终止子进程
   *
   * 内部调用 transport.close()，会 kill MCP server 子进程。
   * 幂等：已关闭时直接返回。
   */
  async close(): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.closeQuietly();
  }

  /**
   * 静默关闭（不抛错，仅 log）
   *
   * 用于 connect 失败时的资源清理，以及 dispose 路径。
   *
   * 关闭顺序（L7 修复）：
   * 1. client.close()：先关闭 MCP 协议层（发送 close 通知给 server）
   * 2. transport.close()：再关闭 stdio 传输（kill 子进程）
   * 顺序错误会导致 server 收不到 close 通知就被 SIGKILL，无法优雅退出。
   */
  private async closeQuietly(): Promise<void> {
    // 1. 先关闭 MCP Client 协议层（L7 修复：之前漏掉 client.close）
    if (this.client !== null) {
      try {
        await this.client.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ serverName: this.config.name, error: message }, 'MCP Client 协议层关闭失败');
      }
    }
    // 2. 再关闭 stdio 传输（kill 子进程）
    try {
      if (this.transport !== null) {
        await this.transport.close();
      }
    } catch (error) {
      // close 失败仅 log warn，不抛错（避免 dispose 路径中断）
      const message = error instanceof Error ? error.message : String(error);
      logger.warn({ serverName: this.config.name, error: message }, 'MCP server 关闭失败');
    } finally {
      this.client = null;
      this.transport = null;
      this.cachedTools = [];
      this.serverName = undefined;
      this.serverVersion = undefined;
      this.connected = false;
    }
  }

  /** 是否已连接 */
  isConnected(): boolean {
    return this.connected;
  }

  /** server 配置 */
  getConfig(): McpServerConfig {
    return this.config;
  }

  /** server 报告的名称（未连接时 undefined） */
  getServerName(): string | undefined {
    return this.serverName;
  }

  /** server 报告的版本（未连接时 undefined） */
  getServerVersion(): string | undefined {
    return this.serverVersion;
  }
}
