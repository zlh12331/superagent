// git.handler.ts：git 域 IPC——status/diff/add/commit/push（透传 gitService，渲染层 git 面板消费）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IGitService } from '../infra/git/git-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：index.ts 传入 gitService */
export interface GitHandlerDeps {
  readonly gitService: IGitService;
}

/** 依赖注入工厂 */
export function createGitHandlers(
  deps: GitHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['git'] {
  const { gitService } = deps;

  return {
    status: async (input) => {
      return gitService.status(input.path);
    },

    diff: async (input) => {
      return gitService.diff({
        path: input.path,
        ref: input.ref,
        staged: input.staged,
        filePath: input.filePath,
      });
    },

    add: async (input) => {
      return gitService.add({
        path: input.path,
        paths: input.paths,
      });
    },

    commit: async (input) => {
      return gitService.commit({
        path: input.path,
        message: input.message,
        amend: input.amend,
      });
    },

    push: async (input) => {
      return gitService.push({
        path: input.path,
        remote: input.remote,
        refspec: input.refspec,
        setUpstream: input.setUpstream,
        force: input.force,
      });
    },
  };
}
