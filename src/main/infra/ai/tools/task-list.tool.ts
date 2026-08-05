// src/main/infra/ai/tools/task-list.tool.ts
// task_list 工具：列出任务（对齐 qwen task_list 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 列出当前会话任务（创建时间倒序），精简展示
// - permission='auto' / category='read'：只读操作（auto 模式只读白名单放行）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { taskService } from '../task-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** task_list 入参 */
const TaskListInputSchema = z.object({
  /** 会话过滤（缺省当前会话） */
  sessionId: z.string().min(1).max(64).optional(),
});

type TaskListInput = z.infer<typeof TaskListInputSchema>;

/** 状态中文标签 */
const STATUS_LABELS: Record<string, string> = {
  pending: '待执行',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/**
 * 创建 task_list 工具（依赖模块级 TaskService 单例）
 */
export function createTaskListTool(): Tool<TaskListInput> {
  return {
    name: 'task_list',
    description:
      '列出任务（缺省当前会话；创建时间倒序）。返回任务 id、状态、描述，供 task_update 引用。',
    inputSchema: TaskListInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (input: TaskListInput, ctx: ToolContext): Promise<ToolResult> => {
      const tasks = taskService.list(input.sessionId ?? ctx.sessionId);
      if (tasks.length === 0) {
        return { title: '任务列表', output: '（当前会话暂无任务）' };
      }
      const lines = tasks.map((task) => {
        const label = STATUS_LABELS[task.status] ?? task.status;
        const ended =
          task.endTime !== null ? ` · ${new Date(task.endTime).toLocaleTimeString()} 结束` : '';
        return `- [${label}] ${task.description.slice(0, 60)}\n  id=${task.id} · 创建 ${new Date(task.startTime).toLocaleString()}${ended}`;
      });
      return {
        title: `任务列表: ${tasks.length} 条`,
        output: lines.join('\n'),
      };
    },
  };
}
