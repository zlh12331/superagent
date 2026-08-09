// src/main/infra/ai/tools/cron-create.tool.ts
// cron_create 工具：创建定时任务（对齐 qwen cron_create 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - 表达式 5 字段（分 时 日 月 周）；非法表达式返回明确错误
// - 任务绑定当前会话；sqlite 持久化（重启保留）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { cronService } from '../cron-service';
import type { Tool, ToolContext, ToolResult } from './tool';

/** cron_create 入参 */
const CronCreateInputSchema = z.object({
  /** cron 表达式（5 字段：分 时 日 月 周；支持 *、步进、范围、列表） */
  expression: z.string().min(5).max(50),
  /** 任务描述 */
  description: z.string().min(1).max(200),
});

type CronCreateInput = z.infer<typeof CronCreateInputSchema>;

/**
 * 创建 cron_create 工具（依赖模块级 CronService 单例）
 */
export function createCronCreateTool(): Tool<CronCreateInput> {
  return {
    name: 'cron_create',
    description:
      '创建定时任务（cron 表达式：分 时 日 月 周）。到点触发后执行任务描述中的指令。例："0 9 * * *" 每天 9 点、"*/30 * * * *" 每 30 分钟。',
    inputSchema: CronCreateInputSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: CronCreateInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const taskId = cronService.create(ctx.sessionId, input.expression, input.description);
        return {
          title: '定时任务已创建',
          output: `任务 ${taskId}\n表达式：${input.expression}\n描述：${input.description}\n下次触发：已排定（列表用 cron_list 查看）`,
        };
      } catch (err: unknown) {
        return {
          title: '定时任务创建失败',
          output: `无效的 cron 表达式：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
