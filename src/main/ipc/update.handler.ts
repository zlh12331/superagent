import type { InferHandlers, IPC_DEFINITIONS, UpdateCacheInfo } from '@code-agent/shared/main';

import type { IUpdateService } from '../infra/update/update-service';
import type { IpcHandlerContext } from '../utils/wrap';

export interface UpdateHandlerDeps {
  readonly updateService: IUpdateService;
  readonly readCacheInfo: () => Promise<UpdateCacheInfo>;
  readonly clearCache: () => Promise<UpdateCacheInfo>;
}

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
