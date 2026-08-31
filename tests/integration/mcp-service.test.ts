// tests/integration/mcp-service.test.ts
// MCP 服务 → 工具注册闭环集成测试：真实 ToolRegistry × MCPService
// ──────────────────────────────────────────────────────────────
// 单测（src/main/infra/ai/mcp/mcp-service.test.ts）mock 掉 ToolRegistry 验证
// "register 被调用"；本集成测试用真实 ToolRegistry 验证 MCP 工具真的注册进
// 注册表、stopServer 注销、重名保护。MCPClient 是外部边界（子进程），仍 mock。
// ──────────────────────────────────────────────────────────────

import type { McpServerConfig } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from '../../src/main/infra/ai/tools/tool';
import { ToolRegistry } from '../../src/main/infra/ai/tools/tool-registry';

// mock MCPClient（外部边界：子进程握手）——构造函数返回可配置实例
const mocks = vi.hoisted(() => {
  const mockMcpClientInstance = {
    connect: vi.fn(async () => {}),
    listTools: vi.fn(),
    callTool: vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })),
    close: vi.fn(async () => {}),
    getConfig: vi.fn(),
    getServerName: vi.fn(),
    getServerVersion: vi.fn(),
    isConnected: vi.fn(() => true),
  };
  return { mockMcpClientInstance };
});

vi.mock('../../src/main/infra/ai/mcp/mcp-client', () => ({
  // biome-ignore lint/style/useNamingConvention: 匹配导出类名
  // biome-ignore lint/complexity/useArrowFunction: 普通函数以支持 new
  MCPClient: vi.fn().mockImplementation(function () {
    return mocks.mockMcpClientInstance;
  }),
}));

import { MCPService } from '../../src/main/infra/ai/mcp/mcp-service';

/** MCP 工具描述符 */
function descriptor(name: string) {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
  };
}

const baseConfig: McpServerConfig = {
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
};

describe('MCPService × ToolRegistry 集成（真实注册表）', () => {
  let registry: ToolRegistry;
  let service: MCPService;
  // MCP 工具名带命名空间前缀 mcp__${serverName}__${toolName}
  const readFileTool = 'mcp__filesystem__read_file';
  const writeFileTool = 'mcp__filesystem__write_file';

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
    service = new MCPService(registry);
    mocks.mockMcpClientInstance.listTools.mockReturnValue([
      descriptor('read_file'),
      descriptor('write_file'),
    ]);
    mocks.mockMcpClientInstance.connect.mockResolvedValue(undefined);
    mocks.mockMcpClientInstance.close.mockResolvedValue(undefined);
    // listServers 读 client.getConfig()（config.name）——返回 baseConfig 快照
    mocks.mockMcpClientInstance.getConfig.mockReturnValue(baseConfig);
  });

  it('startServer：MCP 工具（带命名空间前缀）真实注册进 ToolRegistry', async () => {
    await service.startServer(baseConfig);
    // 真实注册表断言（非 register 调用数——工具真的可查到）
    expect(registry.get(readFileTool)).toBeDefined();
    const names = registry.getAllNames();
    expect(names.has(readFileTool)).toBe(true);
    expect(names.has(writeFileTool)).toBe(true);
  });

  it('stopServer：注销此 server 注册的全部工具', async () => {
    await service.startServer(baseConfig);
    expect(registry.getAllNames().has(readFileTool)).toBe(true);
    await service.stopServer('filesystem');
    expect(registry.getAllNames().has(readFileTool)).toBe(false);
    expect(registry.getAllNames().has(writeFileTool)).toBe(false);
  });

  it('重名保护：同名命名空间工具已被占用时跳过注册（不覆盖）', async () => {
    // 预注册一个与 MCP 工具名冲突的工具（命名空间前缀相同）
    const existing: Tool = {
      name: readFileTool,
      description: '内置 read_file',
      inputSchema: { parse: (v: unknown) => v as never },
      execute: async () => ({ ok: true }),
    };
    registry.register(existing);
    await service.startServer(baseConfig);
    // 重名工具未覆盖：仍返回内置的（描述符不同可区分）
    expect(registry.get(readFileTool)?.description).toBe('内置 read_file');
  });

  it('listServers：启动后 status=running、toolNames 已登记', async () => {
    await service.startServer(baseConfig);
    const servers = await service.listServers();
    const fs = servers.find((s) => s.config.name === 'filesystem');
    expect(fs?.status).toBe('running');
    expect(fs?.toolNames).toEqual(expect.arrayContaining([readFileTool, writeFileTool]));
  });

  it('启动失败：status=error 且不注册工具（容错不抛）', async () => {
    mocks.mockMcpClientInstance.connect.mockRejectedValueOnce(new Error('handshake fail'));
    await service.startServer(baseConfig);
    const servers = await service.listServers();
    const fs = servers.find((s) => s.config.name === 'filesystem');
    expect(fs?.status).toBe('error');
    expect(registry.getAllNames().size).toBe(0);
  });
});
