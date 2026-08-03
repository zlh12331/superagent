// src/main/ipc/codebase.handler.test.ts
// codebase.handler 单测：6 个方法转发（fake CodebaseService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type CodebaseHandlerDeps, createCodebaseHandlers } from './codebase.handler';

/** 创建 fake CodebaseService */
function createFakeCodebaseService() {
  return {
    query: vi.fn(async () => ({ symbols: [] })),
    explore: vi.fn(async () => ({ markdown: '' })),
    node: vi.fn(async () => ({ node: null })),
    callers: vi.fn(async () => ({ callers: [] })),
    callees: vi.fn(async () => ({ callees: [] })),
    impact: vi.fn(async () => ({ impacted: [] })),
  } as unknown as CodebaseHandlerDeps['codebaseService'];
}

const EMPTY_CTX = {} as never;

describe('codebase.handler', () => {
  let codebaseService: ReturnType<typeof createFakeCodebaseService>;
  let handlers: ReturnType<typeof createCodebaseHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    codebaseService = createFakeCodebaseService();
    handlers = createCodebaseHandlers({ codebaseService });
  });

  it('query：转发 search/limit/kind', async () => {
    await handlers.query({ path: '/repo', search: 'Foo', limit: 20, kind: 'class' }, EMPTY_CTX);
    expect(codebaseService.query).toHaveBeenCalledWith({
      path: '/repo',
      search: 'Foo',
      limit: 20,
      kind: 'class',
    });
  });

  it('explore：转发 query/maxFiles', async () => {
    await handlers.explore({ path: '/repo', query: ['auth'], maxFiles: 5 }, EMPTY_CTX);
    expect(codebaseService.explore).toHaveBeenCalledWith({
      path: '/repo',
      query: ['auth'],
      maxFiles: 5,
    });
  });

  it('node：转发 name/file/offset/limit/symbolsOnly', async () => {
    await handlers.node(
      { path: '/repo', name: 'Foo', file: undefined, offset: 0, limit: 50, symbolsOnly: false },
      EMPTY_CTX,
    );
    expect(codebaseService.node).toHaveBeenCalledWith({
      path: '/repo',
      name: 'Foo',
      file: undefined,
      offset: 0,
      limit: 50,
      symbolsOnly: false,
    });
  });

  it('callers/callees/impact：转发 symbol/depth', async () => {
    await handlers.callers({ path: '/repo', symbol: 'Foo', limit: 10 }, EMPTY_CTX);
    expect(codebaseService.callers).toHaveBeenCalledWith({
      path: '/repo',
      symbol: 'Foo',
      limit: 10,
    });
    await handlers.callees({ path: '/repo', symbol: 'Foo', limit: 10 }, EMPTY_CTX);
    expect(codebaseService.callees).toHaveBeenCalledWith({
      path: '/repo',
      symbol: 'Foo',
      limit: 10,
    });
    await handlers.impact({ path: '/repo', symbol: 'Foo', depth: 3 }, EMPTY_CTX);
    expect(codebaseService.impact).toHaveBeenCalledWith({ path: '/repo', symbol: 'Foo', depth: 3 });
  });
});
