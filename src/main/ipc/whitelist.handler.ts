// whitelist.handler.ts：whitelist 域 IPC——审批白名单的增删查（透传 permissionService）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/tools/permission-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：index.ts 传入 permissionService（与其余 handler 的装配风格一致） */
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
