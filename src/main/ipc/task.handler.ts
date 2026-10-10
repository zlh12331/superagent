import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import { taskService } from '../infra/ai/agent/task-service';
import type { IpcHandlerContext } from '../utils/wrap';

export const taskHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['task'] = {
  list: async (input) => {
    const tasks = taskService.list(input.sessionId);
    return {
      tasks: tasks.map((t) => ({
        id: t.id,
        sessionId: t.sessionId,
        kind: t.kind,
        description: t.description,
        status: t.status,
        startTime: t.startTime,
        endTime: t.endTime,
      })),
    };
  },
};
