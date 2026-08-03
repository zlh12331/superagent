// src/main/ipc/tool.handler.test.ts
// tool.handler 单测：tool 域 handler 工厂（定义表驱动模式下测业务函数）
//
// 测试维度：正向（list 转发 + permission 过滤透传）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createToolHandlers, type ToolHandlerDeps } from './tool.handler';

/** 创建 fake ToolRegistry（DI 注入，符合 handler 依赖注入设计） */
function createFakeRegistry(list: ReturnType<typeof vi.fn>) {
  return {
    list,
    register: vi.fn(),
    unregister: vi.fn(() => false),
    get: vi.fn(),
    toAISDKTools: vi.fn(),
  } as unknown as ToolHandlerDeps['toolRegistry'];
}

/** 空 ctx（tool 域不使用 ctx） */
const EMPTY_CTX = {} as never;

describe('tool.handler', () => {
  let list: ReturnType<typeof vi.fn>;
  let handlers: ReturnType<typeof createToolHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    list = vi.fn();
    handlers = createToolHandlers({ toolRegistry: createFakeRegistry(list) });
  });

  it('list（无 permission）：转发 list(undefined) 并返回 tools', async () => {
    list.mockReturnValue([{ name: 'read_file' }, { name: 'write_file' }]);
    const result = await handlers.list({ permission: undefined }, EMPTY_CTX);
    expect(list).toHaveBeenCalledWith(undefined);
    expect(result.tools).toHaveLength(2);
  });

  it('list（permission=ask）：透传过滤参数', async () => {
    list.mockReturnValue([{ name: 'write_file', permission: 'ask' }]);
    const result = await handlers.list({ permission: 'ask' }, EMPTY_CTX);
    expect(list).toHaveBeenCalledWith('ask');
    expect(result.tools[0]).toMatchObject({ name: 'write_file' });
  });

  it('list（空注册表）：返回空数组', async () => {
    list.mockReturnValue([]);
    const result = await handlers.list({ permission: undefined }, EMPTY_CTX);
    expect(result.tools).toEqual([]);
  });
});
