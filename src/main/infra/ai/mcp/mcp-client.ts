// mcp-client.ts：MCP 客户端——官方 SDK Client 包装（stdio/SSE/streamable-http 三传输），
// 远端传输统一走 proxiedFetch（代理感知）
import { AppError, ErrorCode } from '@code-agent/shared/main';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { logger } from '../../../utils/logger';
import { proxiedFetch } from '../../network/proxied-fetch';
import type { McpCallToolFn, McpToolCallResult, McpToolDescriptor } from './mcp-tool-adapter';
import type { McpServerConfig } from './mcp-types';
import { resolveMcpTransport } from './mcp-types';

export function createMcpTransport(config: McpServerConfig): McpTransportInstance {
  const transport = resolveMcpTransport(config);
  if (transport === 'stdio') {
    return new StdioClientTransport({
      command: config.command ?? '',
      ...(config.args !== undefined ? { args: [...config.args] } : {}),
      ...(config.env !== undefined ? { env: { ...config.env } } : {}),
      ...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
      stderr: 'pipe',
    });
  }
  if (config.url === undefined || config.url.length === 0) {
    throw new AppError(ErrorCode.INVALID_INPUT, `MCP server "${config.name}" 缺少 url 配置`);
  }
  const url = new URL(config.url);
  const remoteOptions = {
    ...(config.headers !== undefined ? { requestInit: { headers: { ...config.headers } } } : {}),
    fetch: proxiedFetch as unknown as (url: string | URL, init?: RequestInit) => Promise<Response>,
  };
  if (transport === 'sse') {
    return new SSEClientTransport(url, remoteOptions);
  }
  return new StreamableHTTPClientTransport(url, remoteOptions);
}

export type McpTransportInstance =
  | StdioClientTransport
  | SSEClientTransport
  | StreamableHTTPClientTransport;

export class MCPClient {
  private client: Client | null = null;
  private transport: McpTransportInstance | null = null;
  private cachedTools: readonly McpToolDescriptor[] = [];
  private serverName: string | undefined;
  private serverVersion: string | undefined;
  private connected = false;

  constructor(private readonly config: McpServerConfig) {}

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
      this.transport = createMcpTransport(this.config);

      if (transportKind === 'stdio') {
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

      this.client = new Client(
        { name: 'code-agent-agent', version: '0.1.0' },
        { capabilities: {} },
      );
      await this.client.connect(this.transport as Transport);

      const serverInfo = this.client.getServerVersion();
      this.serverName = serverInfo?.name;
      this.serverVersion = serverInfo?.version;

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
      await this.closeQuietly();
      const message = error instanceof Error ? error.message : String(error);
      logger.error({ serverName: name, error: message }, 'MCP server 启动失败');
      throw new AppError(ErrorCode.INTERNAL_ERROR, `MCP server "${name}" 启动失败：${message}`, {
        cause: error,
      });
    }
  }

  listTools(): readonly McpToolDescriptor[] {
    if (!this.connected) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `MCP server "${this.config.name}" 未连接，无法列出工具`,
      );
    }
    return this.cachedTools;
  }

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

    if (ctx.abortSignal.aborted) {
      throw new AppError(ErrorCode.TOOL_ABORTED, `MCP 工具已中断：${toolName}`);
    }

    try {
      const result = await this.client.callTool(
        {
          name: toolName,
          arguments: input as Record<string, unknown> | undefined,
        },
        undefined,
        { signal: ctx.abortSignal },
      );

      return {
        content: (result.content ?? []) as McpToolCallResult['content'],
        ...(result.structuredContent !== undefined
          ? { structuredContent: result.structuredContent }
          : {}),
        ...(result.isError !== undefined ? { isError: result.isError as boolean } : {}),
      };
    } catch (error) {
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

  async close(): Promise<void> {
    if (!this.connected) {
      return;
    }
    await this.closeQuietly();
  }

  private async closeQuietly(): Promise<void> {
    if (this.client !== null) {
      try {
        await this.client.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ serverName: this.config.name, error: message }, 'MCP Client 协议层关闭失败');
      }
    }
    try {
      if (this.transport !== null) {
        await this.transport.close();
      }
    } catch (error) {
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

  isConnected(): boolean {
    return this.connected;
  }

  getConfig(): McpServerConfig {
    return this.config;
  }

  getServerName(): string | undefined {
    return this.serverName;
  }

  getServerVersion(): string | undefined {
    return this.serverVersion;
  }
}
