// src/main/infra/ai/tools/task-update.tool.ts
// task_update 工具：更新任务状态（对齐 qwen task_update 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 状态机：pending → running → completed / failed / cancelled（终端锁定）
// - permission='auto'：纯元数据写入；终端状态不可逆转（TaskService 强制）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { TaskStatus, taskService } from '../task-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** task_update 入参 */
const TaskUpdateInputSchema = z.object({
  /** 任务 id（task_create 返回） */
  taskId: z.string().min(1).max(64),
  /** 目标状态 */
  status: z.enum([
    TaskStatus.PENDING,
    TaskStatus.RUNNING,
    TaskStatus.COMPLETED,
    TaskStatus.FAILED,
    TaskStatus.CANCELLED,
  ]),
});

type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

/**
 * 创建 task_update 工具（依赖模块级 TaskService 单例）
 */
export function createTaskUpdateTool(): Tool<TaskUpdateInput> {
  return {
    name: 'task_update',
    description:
      '更新任务状态（pending/running/completed/failed/cancelled）。任务进入终端状态（completed/failed/cancelled）后不可再改变。',
    inputSchema: TaskUpdateInputSchema,
    permission: 'auto',
    category: 'exec',
    execute: async (input: TaskUpdateInput, _ctx: ToolContext): Promise<ToolResult> => {
      const ok = taskService.update(input.taskId, input.status);
      if (!ok) {
        return {
          title: '任务更新失败',
          output: `任务 ${input.taskId} 更新为 ${input.status} 失败：任务不存在或已处于终端状态。`,
        };
      }
      return {
        title: `任务状态更新: ${input.status}`,
        output: `任务 ${input.taskId} 已更新为 ${input.status}。`,
      };
    },
  };
}
