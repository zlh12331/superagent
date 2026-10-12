// im.handler.ts：im 域 IPC——IM 渠道列表/启停（渠道适配与 agent 桥在 infra/im，此处纯透传）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ImService } from '../infra/im/im-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：index.ts 传入 imService */
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
