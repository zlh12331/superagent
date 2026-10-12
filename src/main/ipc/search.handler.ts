// search.handler.ts：search 域 IPC——grep/glob（ripgrep 承载），路径先过工作区守卫
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ISearchService } from '../infra/search/search-service';
import type { IpcHandlerContext } from '../utils/wrap';
import { confineToWorkspace, defaultWorkspaceRoots } from './file.handler';

/** 依赖注入工厂：workspaceRoots 可注入（测试），缺省与 file 域共用同一根列表 */
export interface SearchHandlerDeps {
  readonly searchService: ISearchService;
  readonly workspaceRoots?: () => Promise<readonly string[]>;
}

/** 依赖注入工厂 */
export function createSearchHandlers(
  deps: SearchHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['search'] {
  const { searchService } = deps;
  const rootsProvider = deps.workspaceRoots ?? defaultWorkspaceRoots;

  return {
    grep: async (input) => {
      // 逐个路径守卫：部分路径越界时整批拒绝语义由 confineToWorkspace 抛错表达
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
