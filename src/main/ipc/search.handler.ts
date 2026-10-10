import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ISearchService } from '../infra/search/search-service';
import type { IpcHandlerContext } from '../utils/wrap';
import { confineToWorkspace, defaultWorkspaceRoots } from './file.handler';

export interface SearchHandlerDeps {
  readonly searchService: ISearchService;
  readonly workspaceRoots?: () => Promise<readonly string[]>;
}

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
