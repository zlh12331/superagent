import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IGitService } from '../infra/git/git-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * Git 域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 GitService 实现：
 * - 生产环境：ServiceContainer 注入默认 GitService 实例（基于 child_process.spawn('git')）
 * - 测试环境：可注入 mock 实现，不依赖真实 git CLI
 */
export interface GitHandlerDeps {
  /** GitService 实例（由 ServiceContainer 注入） */
  readonly gitService: IGitService;
}

/**
 * 创建 Git 域 handler 实现
 *
 * @param deps 依赖项：包含 IGitService 实例
 */
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
