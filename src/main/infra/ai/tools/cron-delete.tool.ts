import { z } from 'zod';
import { t } from '../../i18n';
import { cronService } from '../agent/cron-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const CronDeleteInputSchema = z.object({
  taskId: z.string().min(1).max(64),
});

type CronDeleteInput = z.infer<typeof CronDeleteInputSchema>;

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
        return { title: t('tools.cron.delete.failed'), output: `任务 ${input.taskId} 不存在。` };
      }
      return {
        title: t('tools.cron.delete.deleted'),
        output: `任务 ${input.taskId} 已删除，不再触发。`,
      };
    },
  };
}
