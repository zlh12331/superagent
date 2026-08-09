// src/main/ipc/goal.handler.ts
// 目标域 IPC handler（goal:create / list / clear，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 3 个请求-响应方法：
// - goal:create  创建会话目标（新建覆盖旧目标）
// - goal:list    查询目标（指定会话或全部）
// - goal:clear   清除会话目标（标记 aborted）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { GoalService } from '../infra/ai/knowledge/goal-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 目标域 handler 工厂（依赖注入：GoalService 由 ServiceContainer 持有）
 */
export function createGoalHandlers(params: {
  goalService: GoalService;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['goal'] {
  const { goalService } = params;
  return {
    // 创建会话目标
    create: async (input) => {
      await goalService.create(input.sessionId, input.condition);
      return { ok: true };
    },

    // 查询目标
    list: async (input) => {
      const goals = await goalService.list(input.sessionId);
      return { goals };
    },

    // 清除会话目标（幂等）
    clear: async (input) => {
      await goalService.clear(input.sessionId);
      return { ok: true };
    },
  };
}
