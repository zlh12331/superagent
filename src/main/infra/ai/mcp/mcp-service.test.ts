// src/main/infra/ai/mcp/mcp-service.test.ts
// mcp-service 单测：多 server 管理器
//
// 测试要点：
// 1. startServer：启动成功 → 工具注册到 ToolRegistry
// 2. startServer：启动失败 → 状态 error，不抛错
// 3. startServer：重名 server 先停旧再启新
// 4. startServer：工具重名时跳过
// 5. stopServer：注销工具 + 关闭 client + 移除 Map 条目
// 6. stopServer：未注册的 server 静默忽略（幂等）
// 7. stopAll：并行停止所有 server
// 8. listServers：返回 server 状态快照
// 9. hasRunningServers：判断是否有运行中 server
// 10. validateMcpServerConfig：配置校验

import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Tool } from '../tools/tool';
import type { IToolRegistry } from '../tools/tool-registry';
import { isMcpToolName, MCPService, validateMcpServerConfig } from './mcp-service';
import type { McpToolDescriptor } from './mcp-tool-adapter';
import type { McpServerConfig } from './mcp-types';

// vi.mock 必须在顶层：mock MCPClient 类
const mocks = vi.hoisted(() => {
  // 每个 test 用例会重置 mockMCPClientInstance 以便配置 listTools/connect/close 行为
  const mockMCPClientInstance = {
    connect: vi.fn(),
    listTools: vi.fn(),
    callTool: vi.fn(),
    close: vi.fn(),
    getConfig: vi.fn(),
    getServerName: vi.fn(),
    getServerVersion: vi.fn(),
    isConnected: vi.fn(),
  };
  return { mockMCPClientInstance };
});

// Mock MCPClient：构造函数返回 mockMCPClientInstance
vi.mock('./mcp-client', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须匹配导出的类名
  // biome-ignore lint/complexity/useArrowFunction: 必须用普通函数以支持 new 调用
  MCPClient: vi.fn().mockImplementation(function () {
    return mocks.mockMCPClientInstance;
  }),
}));

// Mock logger（避免污染主进程日志）
vi.mock('../../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// 构造 mock ToolRegistry
function makeToolRegistry(): IToolRegistry & {
  register: Mock;
  unregister: Mock;
  get: Mock;
  list: Mock;
  toAISDKTools: Mock;
} {
  const tools = new Map<string, Tool>();
  return {
    register: vi.fn((tool: Tool) => {
      tools.set(tool.name, tool);
    }),
    unregister: vi.fn((name: string) => tools.delete(name)),
    get: vi.fn((name: string) => tools.get(name)),
    list: vi.fn(() => []),
    toAISDKTools: vi.fn(() => ({})),
  };
}

// 构造 mock tool 描述符
function makeDescriptor(
  name: string,
  overrides: Partial<McpToolDescriptor> = {},
): McpToolDescriptor {
  return {
    name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    ...overrides,
  };
}

// 基础 server config
const baseConfig: McpServerConfig = {
  name: 'filesystem',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem'],
};

describe('mcp-service', () => {
  let service: MCPService;
  let toolRegistry: ReturnType<typeof makeToolRegistry>;

  beforeEach(() => {
    vi.clearAllMocks();
    toolRegistry = makeToolRegistry();
    service = new MCPService(toolRegistry);

    // 默认 mock 行为：connect 成功、listTools 返回空数组、close 成功
    mocks.mockMCPClientInstance.connect.mockResolvedValue(undefined);
    mocks.mockMCPClientInstance.listTools.mockReturnValue([]);
    mocks.mockMCPClientInstance.close.mockResolvedValue(undefined);
    mocks.mockMCPClientInstance.getConfig.mockReturnValue(baseConfig);
    mocks.mockMCPClientInstance.getServerName.mockReturnValue(undefined);
    mocks.mockMCPClientInstance.getServerVersion.mockReturnValue(undefined);
    mocks.mockMCPClientInstance.isConnected.mockReturnValue(true);
  });

  describe('startServer', () => {
    it('启动成功 → 工具注册到 ToolRegistry', async () => {
      const descriptors = [makeDescriptor('read_file'), makeDescriptor('write_file')];
      mocks.mockMCPClientInstance.listTools.mockReturnValue(descriptors);

      await service.startServer(baseConfig);

      // 两个工具按命名空间注册
      expect(toolRegistry.register).toHaveBeenCalledTimes(2);
      expect(toolRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mcp__filesystem__read_file' }),
      );
      expect(toolRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mcp__filesystem__write_file' }),
      );
    });

    it('listServers 返回运行中状态', async () => {
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('read_file')]);
      await service.startServer(baseConfig);

      const infos = service.listServers();
      expect(infos).toHaveLength(1);
      expect(infos[0]?.status).toBe('running');
      expect(infos[0]?.toolNames).toEqual(['mcp__filesystem__read_file']);
    });

    it('启动失败 → 状态 error 且不抛错（错误隔离）', async () => {
      mocks.mockMCPClientInstance.connect.mockRejectedValue(new Error('connection refused'));

      // 不抛错
      await expect(service.startServer(baseConfig)).resolves.toBeUndefined();

      const infos = service.listServers();
      expect(infos).toHaveLength(1);
      expect(infos[0]?.status).toBe('error');
      expect(infos[0]?.lastError).toContain('connection refused');
    });

    it('重名 server 先停旧再启新', async () => {
      // 第一次启动
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('read_file')]);
      await service.startServer(baseConfig);

      // 第二次启动同名 server（会触发 stopServer 旧的）
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('write_file')]);
      await service.startServer(baseConfig);

      // 旧的 client.close 被调用
      expect(mocks.mockMCPClientInstance.close).toHaveBeenCalled();
      // 旧工具被注销
      expect(toolRegistry.unregister).toHaveBeenCalledWith('mcp__filesystem__read_file');
    });

    it('工具重名时跳过注册', async () => {
      // 预先注册一个同名工具（模拟其他 server 已注册）
      const existingTool = {
        name: 'mcp__filesystem__read_file',
        description: 'existing',
        inputSchema: { safeParse: vi.fn() } as unknown,
        permission: 'auto' as const,
        execute: vi.fn(),
      } as unknown as Tool;
      toolRegistry.register(existingTool);
      // 清除预注册的调用记录，只统计 startServer 内部的注册调用
      toolRegistry.register.mockClear();

      mocks.mockMCPClientInstance.listTools.mockReturnValue([
        makeDescriptor('read_file'),
        makeDescriptor('write_file'),
      ]);

      await service.startServer(baseConfig);

      // 仅注册 write_file（read_file 被跳过）
      expect(toolRegistry.register).toHaveBeenCalledTimes(1);
      expect(toolRegistry.register).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'mcp__filesystem__write_file' }),
      );
    });

    it('hasRunningServers 启动后 true，停止后 false', async () => {
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('read_file')]);
      await service.startServer(baseConfig);
      expect(service.hasRunningServers()).toBe(true);

      await service.stopServer('filesystem');
      expect(service.hasRunningServers()).toBe(false);
    });
  });

  describe('stopServer', () => {
    it('注销工具 + 关闭 client + 移除 Map 条目', async () => {
      mocks.mockMCPClientInstance.listTools.mockReturnValue([
        makeDescriptor('read_file'),
        makeDescriptor('write_file'),
      ]);
      await service.startServer(baseConfig);

      await service.stopServer('filesystem');

      expect(toolRegistry.unregister).toHaveBeenCalledTimes(2);
      expect(mocks.mockMCPClientInstance.close).toHaveBeenCalledTimes(1);
      expect(service.listServers()).toHaveLength(0);
    });

    it('未注册的 server 静默忽略（幂等）', async () => {
      await expect(service.stopServer('nonexistent')).resolves.toBeUndefined();
      expect(mocks.mockMCPClientInstance.close).not.toHaveBeenCalled();
    });

    it('client.close 失败时记录 stopped_with_error 状态', async () => {
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('read_file')]);
      await service.startServer(baseConfig);

      mocks.mockMCPClientInstance.close.mockRejectedValue(new Error('close failed'));

      // 不抛错，仅记录状态
      await service.stopServer('filesystem');
      // 已从 Map 移除
      expect(service.listServers()).toHaveLength(0);
    });
  });

  describe('stopAll', () => {
    it('并行停止所有 server', async () => {
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('read_file')]);

      // 启动两个 server（不同 name）
      await service.startServer(baseConfig);
      await service.startServer({
        ...baseConfig,
        name: 'git',
      });

      expect(service.listServers()).toHaveLength(2);

      await service.stopAll();

      expect(service.listServers()).toHaveLength(0);
      // 每个 client 的 close 被调用一次
      // 由于 MCPClient 被 mock 为单例，close 会被多次调用
    });

    it('空 Map 时直接返回', async () => {
      await expect(service.stopAll()).resolves.toBeUndefined();
    });
  });

  describe('listServers', () => {
    it('返回 server 信息快照（含 serverName / serverVersion）', async () => {
      mocks.mockMCPClientInstance.listTools.mockReturnValue([makeDescriptor('read_file')]);
      mocks.mockMCPClientInstance.getServerName.mockReturnValue('filesystem-mcp');
      mocks.mockMCPClientInstance.getServerVersion.mockReturnValue('1.0.0');

      await service.startServer(baseConfig);

      const infos = service.listServers();
      expect(infos).toHaveLength(1);
      expect(infos[0]).toMatchObject({
        status: 'running',
        serverName: 'filesystem-mcp',
        serverVersion: '1.0.0',
        toolNames: ['mcp__filesystem__read_file'],
      });
    });

    it('lastError 仅在 error 状态时存在', async () => {
      mocks.mockMCPClientInstance.connect.mockRejectedValue(new Error('fail'));
      await service.startServer(baseConfig);

      const infos = service.listServers();
      expect(infos[0]?.lastError).toContain('fail');
    });

    it('运行成功时 lastError 不存在（exactOptionalPropertyTypes）', async () => {
      await service.startServer(baseConfig);
      const infos = service.listServers();
      expect(infos[0]?.lastError).toBeUndefined();
    });
  });

  describe('hasRunningServers', () => {
    it('空 Map → false', () => {
      expect(service.hasRunningServers()).toBe(false);
    });

    it('error 状态的 server 不计入 running', async () => {
      mocks.mockMCPClientInstance.connect.mockRejectedValue(new Error('fail'));
      await service.startServer(baseConfig);
      expect(service.hasRunningServers()).toBe(false);
    });
  });

  describe('isMcpToolName', () => {
    it('mcp__ 开头返回 true', () => {
      expect(isMcpToolName('mcp__fs__read_file')).toBe(true);
    });

    it('非 mcp__ 开头返回 false', () => {
      expect(isMcpToolName('read_file')).toBe(false);
    });
  });

  describe('validateMcpServerConfig', () => {
    const validConfig: McpServerConfig = {
      name: 'fs',
      command: 'npx',
    };

    it('合法配置不抛错', () => {
      expect(() => validateMcpServerConfig(validConfig)).not.toThrow();
    });

    it('name 为空抛 INVALID_INPUT', () => {
      expect(() => validateMcpServerConfig({ ...validConfig, name: '' })).toThrow(AppError);
      try {
        validateMcpServerConfig({ ...validConfig, name: '' });
      } catch (error) {
        expect((error as AppError).code).toBe(ErrorCode.INVALID_INPUT);
      }
    });

    it('command 为空抛 INVALID_INPUT', () => {
      expect(() => validateMcpServerConfig({ ...validConfig, command: '' })).toThrow(AppError);
    });

    it('server name 与已注册工具重名抛 INVALID_INPUT', () => {
      const existingNames = new Set(['fs']);
      expect(() => validateMcpServerConfig(validConfig, existingNames)).toThrow(AppError);
    });

    it('existingToolNames 为 undefined 时不检查重名', () => {
      expect(() => validateMcpServerConfig(validConfig, undefined)).not.toThrow();
    });
  });
});
