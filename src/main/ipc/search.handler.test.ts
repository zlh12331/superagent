// src/main/ipc/search.handler.test.ts
// search.handler 单测：grep/glob 转发（fake SearchService DI 注入）

import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSearchHandlers, type SearchHandlerDeps } from './search.handler';

/** 创建 fake SearchService */
function createFakeSearchService() {
  return {
    grep: vi.fn(async () => ({ matches: [], truncated: false })),
    glob: vi.fn(async () => ({ files: [], truncated: false })),
  } as unknown as SearchHandlerDeps['searchService'];
}

const EMPTY_CTX = {} as never;

describe('search.handler', () => {
  let searchService: ReturnType<typeof createFakeSearchService>;
  let handlers: ReturnType<typeof createSearchHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    searchService = createFakeSearchService();
    // 2026-09-08：handler 现对 path/paths 做工作区收口（confineToWorkspace），
    // 测试注入固定根集合使守卫放行
    handlers = createSearchHandlers({
      searchService,
      workspaceRoots: async () => ['/'],
    });
  });

  it('grep：转发全部参数', async () => {
    await handlers.grep(
      {
        pattern: 'foo',
        paths: [],
        caseSensitive: false,
        isRegex: true,
        include: undefined,
        exclude: [],
        maxResults: 100,
      },
      EMPTY_CTX,
    );
    expect(searchService.grep).toHaveBeenCalledWith({
      pattern: 'foo',
      paths: [],
      caseSensitive: false,
      isRegex: true,
      include: undefined,
      exclude: [],
      maxResults: 100,
    });
  });

  it('glob：转发 pattern/path/includeHidden/maxResults', async () => {
    await handlers.glob(
      { pattern: '*.ts', path: '/src', includeHidden: false, maxResults: 1000 },
      EMPTY_CTX,
    );
    // 2026-09-08：path 经 confineToWorkspace 解析为绝对路径（根集合 ['/'] 下
    // '/src' → 平台根下的 src），故用 resolve 后的值断言
    expect(searchService.glob).toHaveBeenCalledWith({
      pattern: '*.ts',
      path: resolve('/', 'src'),
      includeHidden: false,
      maxResults: 1000,
    });
  });
});
