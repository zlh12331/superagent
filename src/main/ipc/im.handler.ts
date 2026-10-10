import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ImService } from '../infra/im/im-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * IM 域 handler 工厂（依赖注入：ImService 由 ServiceContainer 持有）
 */
export function createImHandlers(params: {
  imService: ImService;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['im'] {
  const { imService } = params;
  return {
    list: async () => {
      const channels = await imService.list();
      return { channels };
    },

    start: async (input) => {
      await imService.start(input.kind, input.token);
      return { ok: true };
    },

    stop: async (input) => {
      await imService.stop(input.kind);
      return { ok: true };
    },
  };
}
