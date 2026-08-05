// src/main/ipc/task.handler.ts
// 任务域 IPC handler（task:list，定义表驱动）
// ──────────────────────────────────────────────
// 实现 1 个请求-响应方法：
// - task:list  列出任务（任务面板展示）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import { taskService } from '../infra/ai/task-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 任务域 handler 实现（依赖模块级 taskService 单例） */
export const taskHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['task'] = {
  // 列出任务
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
