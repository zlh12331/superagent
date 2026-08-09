// src/main/infra/ai/tools/task-stop.tool.ts
// task_stop 工具：中止任务（对齐 qwen-code task-stop）
// ──────────────────────────────────────────────────────────────
// 语义：将任务状态置为 CANCELLED（task_update 的语义化别名，
// 面向"中止/取消"场景的专用入口，避免 LLM 混淆通用状态机）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { TaskStatus, taskService } from '../agent/task-service';
import type { Tool, ToolContext, ToolResult } from './tool';

/** task_stop 入参 */
const TaskStopInputSchema = z.object({
  /** 任务 id（task_create 返回） */
  taskId: z.string().min(1).max(64),
  /** 中止原因（记录用） */
  reason: z.string().max(200).optional(),
});

type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

/**
 * 创建 task_stop 工具
 */
export function createTaskStopTool(): Tool {
  return {
    name: 'task_stop',
    description:
      '中止任务：将任务状态置为已取消（CANCELLED）。用于任务不再需要继续执行、或需要终止长期运行任务时。',
    permission: 'auto' as const,
    category: 'exec' as const,
    inputSchema: TaskStopInputSchema,
    async execute(input: TaskStopInput, _ctx: ToolContext): Promise<ToolResult> {
      const ok = taskService.update(input.taskId, TaskStatus.CANCELLED);
      if (!ok) {
        return {
          title: '任务中止失败',
          output: `任务 ${input.taskId} 中止失败：任务不存在或已处于终端状态。`,
        };
      }
      return {
        title: '任务已中止',
        output: `任务 ${input.taskId} 已中止（CANCELLED）${input.reason !== undefined ? `，原因：${input.reason}` : ''}。`,
      };
    },
  };
}
