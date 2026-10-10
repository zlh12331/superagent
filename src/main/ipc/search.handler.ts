import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ISearchService } from '../infra/search/search-service';
import type { IpcHandlerContext } from '../utils/wrap';
import { confineToWorkspace, defaultWorkspaceRoots } from './file.handler';

/**
 * 搜索域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 SearchService 实现：
 * - 生产环境：ServiceContainer 注入默认 SearchService 实例
 * - 测试环境：可注入 mock 实现，不依赖真实 ripgrep 子进程
 */
export interface SearchHandlerDeps {
  /** SearchService 实例（由 ServiceContainer 注入） */
  readonly searchService: ISearchService;
  /**
   * 可选：工作区根集合提供者（边界来源）
   *
   * 缺省实现读取会话 workingDir 集合（与 file.handler 同源）；
   * 测试可注入自定义实现。返回绝对路径数组。
   */
  readonly workspaceRoots?: () => Promise<readonly string[]>;
}

/**
 * 创建搜索域 handler 实现
 *
 * @param deps 依赖项：包含 ISearchService 实例
 */
export function createSearchHandlers(
  deps: SearchHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['search'] {
  const { searchService } = deps;
  const rootsProvider = deps.workspaceRoots ?? defaultWorkspaceRoots;

  return {
    grep: async (input) => {
      const paths: string[] = [];
      for (const p of input.paths) {
        paths.push(await confineToWorkspace(p, rootsProvider));
      }
      return searchService.grep({
        pattern: input.pattern,
        paths,
        caseSensitive: input.caseSensitive,
        isRegex: input.isRegex,
        include: input.include,
        exclude: input.exclude,
        maxResults: input.maxResults,
      });
    },

    glob: async (input) => {
      const path = await confineToWorkspace(input.path, rootsProvider);
      return searchService.glob({
        pattern: input.pattern,
        path,
        includeHidden: input.includeHidden,
        maxResults: input.maxResults,
      });
    },
  };
}
