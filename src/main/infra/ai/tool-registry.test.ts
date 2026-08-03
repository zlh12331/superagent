// src/main/infra/ai/tool-registry.test.ts
// ToolRegistry 单测：注册 / 查找 / 注销 / 列表 / AI SDK 转换

import { describe, expect, it, vi } from 'vitest';
import type { Tool } from './tool';
import { ToolRegistry } from './tool-registry';

const mocks = vi.hoisted(() => ({
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({ logger: mocks.mockLogger }));

/** 构造 mock 工具 */
function createTool(name: string, permission: 'auto' | 'ask' = 'auto'): Tool {
  return {
    name,
    description: `${name} 描述`,
    inputSchema: undefined as unknown as Tool['inputSchema'],
    permission,
    execute: vi.fn(async () => ({ title: 'ok', output: 'done' })),
  } as unknown as Tool;
}

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ToolRegistry();
  });

  it('register + get：注册后可获取', () => {
    const tool = createTool('read_file');
    registry.register(tool);
    expect(registry.get('read_file')).toBe(tool);
  });

  it('register 空名：抛 TOOL_NOT_FOUND', () => {
    const tool = createTool('') as Tool;
    expect(() => registry.register(tool)).toThrow();
  });

  it('register 重复名：抛错', () => {
    registry.register(createTool('x'));
    expect(() => registry.register(createTool('x'))).toThrow(/已注册/);
  });

  it('unregister：返回是否删除成功', () => {
    registry.register(createTool('x'));
    expect(registry.unregister('x')).toBe(true);
    expect(registry.unregister('x')).toBe(false);
    expect(registry.get('x')).toBeUndefined();
  });

  it('get 未注册：返回 undefined', () => {
    expect(registry.get('nope')).toBeUndefined();
  });

  it('list：按 name 字母序返回描述符', () => {
    registry.register(createTool('write_file'));
    registry.register(createTool('read_file'));
    const list = registry.list();
    expect(list.map((t) => t.name)).toEqual(['read_file', 'write_file']);
  });

  it('list（permission 过滤）：只返回匹配权限', () => {
    registry.register(createTool('read_file', 'auto'));
    registry.register(createTool('write_file', 'ask'));
    expect(registry.list('auto').map((t) => t.name)).toEqual(['read_file']);
    expect(registry.list('ask').map((t) => t.name)).toEqual(['write_file']);
  });

  it('toAISDKTools：转换全部工具为 AI SDK 格式', () => {
    registry.register(createTool('read_file'));
    registry.register(createTool('write_file', 'ask'));
    const aiTools = registry.toAISDKTools({
      workingDir: '/tmp',
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      webContents: {} as never,
    });
    expect(Object.keys(aiTools).sort()).toEqual(['read_file', 'write_file']);
  });

  it('toAISDKTools：execute 回调携带完整 ToolContext（含 callId）', async () => {
    const execute = vi.fn(async () => ({ title: 'ok', output: 'done' }));
    registry.register({
      name: 'mock_tool',
      description: 'd',
      inputSchema: undefined as unknown as Tool['inputSchema'],
      permission: 'auto',
      execute,
    } as unknown as Tool);
    const aiTools = registry.toAISDKTools({
      workingDir: '/tmp',
      sessionId: 's1',
      abortSignal: new AbortController().signal,
      webContents: {} as never,
    });
    const tool = aiTools['mock_tool'];
    if (tool?.execute === undefined) {
      throw new Error('mock_tool 应被转换且含 execute');
    }
    await tool.execute({}, {
      toolCallId: 'call-1',
      messages: [],
      context: {},
    } as never);
    expect(execute).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ workingDir: '/tmp', sessionId: 's1', callId: 'call-1' }),
    );
  });
});
