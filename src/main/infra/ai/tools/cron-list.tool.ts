// src/main/infra/ai/tools/cron-list.tool.ts
// cron_list 工具：列出定时任务（对齐 qwen cron_list 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 列出全部定时任务（创建时间倒序），精简展示
// - permission='auto' / category='read'：只读
// ──────────────────────────────────────────────────────────────

import { cronService } from '../cron-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** cron_list 入参（无字段） */
const CronListInputSchema = undefined;

/**
 * 创建 cron_list 工具（依赖模块级 CronService 单例）
 */
export function createCronListTool(): Tool<undefined> {
  return {
    name: 'cron_list',
    description: '列出全部定时任务（表达式、状态、下次触发时间）。',
    inputSchema: CronListInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (_input: undefined, _ctx: ToolContext): Promise<ToolResult> => {
      const tasks = cronService.list();
      if (tasks.length === 0) {
        return { title: '定时任务列表', output: '（暂无定时任务）' };
      }
      const lines = tasks.map((task) => {
        const status = task.enabled ? '启用' : '停用';
        const next =
          task.nextFireAt !== null ? new Date(task.nextFireAt).toLocaleString() : '未排定';
        return `- [${status}] ${task.description.slice(0, 50)}\n  表达式 ${task.expression} · 下次 ${next} · id=${task.id}`;
      });
      return {
        title: `定时任务: ${tasks.length} 条`,
        output: lines.join('\n'),
      };
    },
  };
}
