// cron-list.tool.ts：cron_list 工具——列定时任务
import { z } from 'zod';
import { t } from '../../i18n';
import { cronService } from '../agent/cron-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const CronListInputSchema = z.object({});

export function createCronListTool(): Tool<Record<string, never>> {
  return {
    name: 'cron_list',
    description: '列出全部定时任务（表达式、状态、下次触发时间）。',
    inputSchema: CronListInputSchema,
    permission: 'auto',
    category: 'read',
    execute: async (_input: Record<string, never>, _ctx: ToolContext): Promise<ToolResult> => {
      const tasks = cronService.list();
      if (tasks.length === 0) {
        return { title: t('tools.cron.list.title'), output: '（暂无定时任务）' };
      }
      const lines = tasks.map((task) => {
        const status = task.enabled ? '启用' : '停用';
        const next =
          task.nextFireAt !== null ? new Date(task.nextFireAt).toLocaleString() : '未排定';
        return `- [${status}] ${task.description.slice(0, 50)}\n  表达式 ${task.expression} · 下次 ${next} · id=${task.id}`;
      });
      return {
        title: t('tools.cron.list.titleWithCount', { count: tasks.length }),
        output: lines.join('\n'),
      };
    },
  };
}
