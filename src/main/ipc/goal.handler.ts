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
    create: async (input) => {
      await goalService.create(input.sessionId, input.condition);
      return { ok: true };
    },

    list: async (input) => {
      const goals = await goalService.list(input.sessionId);
      return { goals };
    },

    clear: async (input) => {
      await goalService.clear(input.sessionId);
      return { ok: true };
    },
  };
}
