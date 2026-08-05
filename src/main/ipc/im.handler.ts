// src/main/ipc/im.handler.ts
// IM 渠道域 IPC handler（渠道列表 / 启停，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 3 个请求-响应方法：
// - im:list   渠道状态列表（设置页展示）
// - im:start  启动渠道（token 首次传入后存 keychain）
// - im:stop   停止渠道
//
// 设计：
// - ImService 模块单例（与 ServiceContainer 生命周期一致，dispose 时 stopAll）
// - token 不落库：keychain（im:${kind}）
// - 骨架渠道（未实现）start 抛 IM_CHANNEL_NOT_IMPLEMENTED

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
    // 渠道状态列表
    list: async () => {
      const channels = await imService.list();
      return { channels };
    },

    // 启动渠道（token 首次传入时存入 keychain）
    start: async (input) => {
      await imService.start(input.kind, input.token);
      return { ok: true };
    },

    // 停止渠道（幂等）
    stop: async (input) => {
      await imService.stop(input.kind);
      return { ok: true };
    },
  };
}
