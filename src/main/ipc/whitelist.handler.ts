// src/main/ipc/whitelist.handler.ts
// 命令白名单域 IPC handler（whitelist:list / add / remove，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 3 个请求-响应方法：
// - whitelist:list    列出全部白名单条目
// - whitelist:add     添加条目（工具名 + 命令模式，立即持久化）
// - whitelist:remove  移除条目（立即持久化）
// 数据源：PermissionService（持久化于 userData/whitelist.json）

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
    // 列出全部白名单条目
    list: async () => {
      const entries = permissionService.listWhitelist();
      return { entries };
    },

    // 添加白名单条目（幂等：同工具 + 同模式不重复）
    add: async (input) => {
      await permissionService.addWhitelistEntry(input);
      return { ok: true };
    },

    // 移除白名单条目（幂等）
    remove: async (input) => {
      await permissionService.removeWhitelistEntry(input);
      return { ok: true };
    },
  };
}
