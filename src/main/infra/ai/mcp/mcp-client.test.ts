// src/main/infra/ai/mcp/mcp-client.test.ts
// mcp-client 单测：单个 MCP server 客户端封装
//
// 测试要点：
// 1. connect：启动成功 → 缓存工具列表
// 2. connect：启动失败 → 抛 AppError(INTERNAL_ERROR)
// 3. connect：已连接时幂等（不重复启动）
// 4. listTools：未连接时抛 INTERNAL_ERROR
// 5. callTool：转发调用并返回标准化结果
// 6. callTool：未连接时抛 INTERNAL_ERROR
// 7. callTool：转发失败抛 TOOL_EXECUTION_FAILED
// 8. close：幂等（已关闭时直接返回）

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ToolContext } from '../tool';
import { MCPClient } from './mcp-client';
import type { McpServerConfig } from './mcp-types';

// vi.mock 必须在顶层
const mocks = vi.hoisted(() => {
  const mockClient = {
    connect: vi.fn(),
    getServerVersion: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
  };
  const mockTransport = {
    stderr: null as { on?: unknown } | null,
    close: vi.fn(),
  };
  return { mockClient, mockTransport };
});

// Mock @modelcontextprotocol/sdk 的 Client 与 StdioClientTransport
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须匹配 SDK 导出的类名
  // biome-ignore lint/complexity/useArrowFunction: 必须用普通函数以支持 new 调用
  Client: vi.fn().mockImplementation(function () {
    return mocks.mockClient;
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须匹配 SDK 导出的类名
  // biome-ignore lint/complexity/useArrowFunction: 必须用普通函数以支持 new 调用
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return mocks.mockTransport;
  }),
}));

// Mock logger
vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const baseConfig: McpServerConfig = {
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  env: {
    // biome-ignore lint/style/useNamingConvention: 标准环境变量名
    NODE_ENV: 'test',
  },
  cwd: '/tmp',
};

function makeCtx(): ToolContext {
  return {
    workingDir: '/workspace',
    sessionId: 'session',
    abortSignal: new AbortController().signal,
  };
}

describe('mcp-client', () => {
  let client: MCPClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new MCPClient(baseConfig);

    // 默认 mock 行为
    mocks.mockClient.connect.mockResolvedValue(undefined);
    mocks.mockClient.getServerVersion.mockReturnValue({
      name: 'filesystem-mcp',
      version: '1.0.0',
    });
    mocks.mockClient.listTools.mockResolvedValue({
      tools: [
        {
          name: 'read_file',
          description: '读取文件',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true },
        },
      ],
    });
    mocks.mockClient.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'file content' }],
    });
    mocks.mockTransport.close.mockResolvedValue(undefined);
    mocks.mockTransport.stderr = null;
  });

  describe('connect', () => {
    it('启动成功 → 缓存工具列表 + isConnected true', async () => {
      await client.connect();
      expect(client.isConnected()).toBe(true);
      expect(mocks.mockClient.connect).toHaveBeenCalledOnce();
      expect(mocks.mockClient.listTools).toHaveBeenCalledOnce();
    });

    it('已连接时幂等（不重复启动）', async () => {
      await client.connect();
      await client.connect(); // 第二次直接返回
      expect(mocks.mockClient.connect).toHaveBeenCalledOnce();
    });

    it('启动失败 → 抛 AppError(INTERNAL_ERROR) + isConnected false', async () => {
      mocks.mockClient.connect.mockRejectedValue(new Error('spawn failed'));

      await expect(client.connect()).rejects.toMatchObject({
        code: ErrorCode.INTERNAL_ERROR,
      });
      expect(client.isConnected()).toBe(false);
    });

    it('启动失败后调用 close 不抛错（资源清理）', async () => {
      mocks.mockClient.connect.mockRejectedValue(new Error('fail'));
      await expect(client.connect()).rejects.toThrow();
      // close 幂等
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe('listTools', () => {
    it('未连接时抛 INTERNAL_ERROR', () => {
      expect(() => client.listTools()).toThrow(AppError);
      try {
        client.listTools();
      } catch (error) {
        expect((error as AppError).code).toBe(ErrorCode.INTERNAL_ERROR);
      }
    });

    it('连接后返回缓存的工具列表', async () => {
      await client.connect();
      const tools = client.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        name: 'read_file',
        description: '读取文件',
      });
    });

    it('工具描述符含 inputSchema（透传 MCP server）', async () => {
      await client.connect();
      const tools = client.listTools();
      expect(tools[0]?.inputSchema).toEqual({ type: 'object', properties: {} });
    });

    it('工具描述符含 annotations.readOnlyHint', async () => {
      await client.connect();
      const tools = client.listTools();
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true);
    });
  });

  describe('callTool', () => {
    it('转发调用并返回标准化结果', async () => {
      await client.connect();

      const ctx = makeCtx();
      const result = await client.callTool('read_file', { path: '/tmp/x' }, ctx);

      expect(mocks.mockClient.callTool).toHaveBeenCalledWith({
        name: 'read_file',
        arguments: { path: '/tmp/x' },
      });
      expect(result).toMatchObject({
        content: [{ type: 'text', text: 'file content' }],
      });
    });

    it('未连接时抛 INTERNAL_ERROR', async () => {
      const ctx = makeCtx();
      await expect(client.callTool('read_file', {}, ctx)).rejects.toMatchObject({
        code: ErrorCode.INTERNAL_ERROR,
      });
    });

    it('转发失败抛 TOOL_EXECUTION_FAILED', async () => {
      await client.connect();
      mocks.mockClient.callTool.mockRejectedValue(new Error('server error'));

      const ctx = makeCtx();
      await expect(client.callTool('read_file', {}, ctx)).rejects.toMatchObject({
        code: ErrorCode.TOOL_EXECUTION_FAILED,
      });
    });

    it('isError=true 透传到结果（由 normalizeMcpToolResult 处理）', async () => {
      await client.connect();
      mocks.mockClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: 'boom' }],
        isError: true,
      });

      const ctx = makeCtx();
      const result = await client.callTool('read_file', {}, ctx);
      expect(result.isError).toBe(true);
    });

    it('structuredContent 透传到结果', async () => {
      await client.connect();
      mocks.mockClient.callTool.mockResolvedValue({
        content: [{ type: 'text', text: '...' }],
        structuredContent: { custom: 'data' },
      });

      const ctx = makeCtx();
      const result = await client.callTool('read_file', {}, ctx);
      expect(result.structuredContent).toEqual({ custom: 'data' });
    });
  });

  describe('close', () => {
    it('已连接时调用 transport.close', async () => {
      await client.connect();
      await client.close();
      expect(mocks.mockTransport.close).toHaveBeenCalledOnce();
    });

    it('未连接时幂等（不调用 transport.close）', async () => {
      await client.close();
      expect(mocks.mockTransport.close).not.toHaveBeenCalled();
    });

    it('已关闭后再次 close 幂等', async () => {
      await client.connect();
      await client.close();
      await client.close();
      expect(mocks.mockTransport.close).toHaveBeenCalledOnce();
    });

    it('transport.close 失败仅 log warn，不抛错', async () => {
      await client.connect();
      mocks.mockTransport.close.mockRejectedValue(new Error('close fail'));
      await expect(client.close()).resolves.toBeUndefined();
    });
  });

  describe('getServerName / getServerVersion', () => {
    it('连接后返回 server 报告的名称与版本', async () => {
      await client.connect();
      expect(client.getServerName()).toBe('filesystem-mcp');
      expect(client.getServerVersion()).toBe('1.0.0');
    });

    it('未连接时返回 undefined', () => {
      expect(client.getServerName()).toBeUndefined();
      expect(client.getServerVersion()).toBeUndefined();
    });
  });

  describe('getConfig', () => {
    it('返回构造时传入的配置', () => {
      expect(client.getConfig()).toBe(baseConfig);
    });
  });
});
