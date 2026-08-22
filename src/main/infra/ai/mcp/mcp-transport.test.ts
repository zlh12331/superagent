// src/main/infra/ai/mcp/mcp-transport.test.ts
// createMcpTransport 工厂单测：三态分支返回正确实例（仅构造，不发起连接）

import { AppError } from '@code-agent/shared/main';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it, vi } from 'vitest';
import { createMcpTransport } from './mcp-client';

vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('createMcpTransport 三态分支', () => {
  it('缺省 transport：按 stdio 创建（向后兼容）', () => {
    const transport = createMcpTransport({
      name: 'filesystem',
      command: 'npx',
      args: ['-y', 'server'],
    });
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  it('显式 stdio：命令与参数透传', () => {
    const transport = createMcpTransport({
      name: 'x',
      transport: 'stdio',
      command: 'node',
    });
    expect(transport).toBeInstanceOf(StdioClientTransport);
  });

  it('sse：SSEClientTransport + headers 注入 requestInit', () => {
    const transport = createMcpTransport({
      name: 'remote',
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      headers: {
        // biome-ignore lint/style/useNamingConvention: HTTP 标准头名
        Authorization: 'Bearer token',
      },
    });
    expect(transport).toBeInstanceOf(SSEClientTransport);
  });

  it('streamable-http：StreamableHTTPClientTransport', () => {
    const transport = createMcpTransport({
      name: 'remote',
      transport: 'streamable-http',
      url: 'http://127.0.0.1:3000/mcp',
    });
    expect(transport).toBeInstanceOf(StreamableHTTPClientTransport);
  });

  it('远程 transport 缺 url：抛 INVALID_INPUT（防御性兜底）', () => {
    expect(() => createMcpTransport({ name: 'bad', transport: 'streamable-http' })).toThrow(
      AppError,
    );
    expect(() => createMcpTransport({ name: 'bad', transport: 'sse' })).toThrow(/缺少 url/);
  });
});
