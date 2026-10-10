import type { InferHandlers, IPC_DEFINITIONS, UpdateCacheInfo } from '@code-agent/shared/main';

import type { IUpdateService } from '../infra/update/update-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** Update 域 handler 依赖 */
export interface UpdateHandlerDeps {
  /** 自动更新服务（由 ServiceContainer 注入） */
  readonly updateService: IUpdateService;
  /** 读取更新缓存占用（默认实现见 infra/update/update-cache；测试可注入 fake） */
  readonly readCacheInfo: () => Promise<UpdateCacheInfo>;
  /** 清理更新缓存（同上） */
  readonly clearCache: () => Promise<UpdateCacheInfo>;
}

/** update 域 handler 实现（check + install + cancel + getStatus + getCacheInfo + clearCache） */
export function createUpdateHandlers(
  deps: UpdateHandlerDeps,
): Pick<
  InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['update'],
  'check' | 'install' | 'cancel' | 'getStatus' | 'getCacheInfo' | 'clearCache'
> {
  return {
    check: async (input) => {
      return deps.updateService.check(input.manual ?? false);
    },
    install: async () => {
      deps.updateService.quitAndInstall();
      return { ok: true };
    },
    cancel: async () => {
      deps.updateService.cancelDownload();
      return { ok: true };
    },
    getStatus: async () => {
      return deps.updateService.getStatus();
    },
    getCacheInfo: async () => {
      return deps.readCacheInfo();
    },
    clearCache: async () => {
      return deps.clearCache();
    },
  };
}
