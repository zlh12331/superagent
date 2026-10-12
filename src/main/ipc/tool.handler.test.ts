import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createToolHandlers, type ToolHandlerDeps } from './tool.handler';

function createFakeRegistry(list: ReturnType<typeof vi.fn>) {
  return {
    list,
    register: vi.fn(),
    unregister: vi.fn(() => false),
    get: vi.fn(),
    toAISDKTools: vi.fn(),
  } as unknown as ToolHandlerDeps['toolRegistry'];
}

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
