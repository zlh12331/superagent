// src/main/infra/ai/tools/cron-delete.tool.ts
// cron_delete 工具：删除定时任务（对齐 qwen cron_delete 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 删除指定任务（幂等）；任务不存在返回明确提示
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { cronService } from '../cron-service';
import type { Tool, ToolContext, ToolResult } from '../tool';

/** cron_delete 入参 */
const CronDeleteInputSchema = z.object({
  /** 任务 id（cron_list 可查） */
  taskId: z.string().min(1).max(64),
});

type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;

/**
 * 创建 cron_delete 工具（依赖模块级 CronService 单例）
 */
export function createCronDeleteTool(): Tool<CronDeleteInput> {
  return {
    name: 'cron_delete',
    description: '删除指定定时任务（id 通过 cron_list 获取）。删除后不再触发。',
    inputSchema: CronDeleteInputSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: CronDeleteInput, _ctx: ToolContext): Promise<ToolResult> => {
      const ok = cronService.delete(input.taskId);
      if (!ok) {
        return { title: '定时任务删除失败', output: `任务 ${input.taskId} 不存在。` };
      }
      return { title: '定时任务已删除', output: `任务 ${input.taskId} 已删除，不再触发。` };
    },
  };
}
