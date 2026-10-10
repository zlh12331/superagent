import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/tools/permission-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 白名单域 handler 工厂（依赖注入：PermissionService 由 ServiceContainer 持有）
 */
export function createWhitelistHandlers(params: {
  permissionService: IPermissionService;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['whitelist'] {
  const { permissionService } = params;
  return {
    list: async () => {
      const entries = permissionService.listWhitelist();
      return { entries };
    },

    add: async (input) => {
      await permissionService.addWhitelistEntry(input);
      return { ok: true };
    },

    remove: async (input) => {
      await permissionService.removeWhitelistEntry(input);
      return { ok: true };
    },
  };
}
