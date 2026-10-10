import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/tools/permission-service';
import type { IpcHandlerContext } from '../utils/wrap';

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
