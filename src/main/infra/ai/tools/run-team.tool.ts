import { z } from 'zod';
import { t } from '../../i18n';
import { teamService } from '../agent/team-service';
import type { Tool, ToolContext, ToolResult } from './tool';

const RunTeamInputSchema = z.object({
  members: z
    .array(
      z.object({
        agent: z.string().min(1).max(100),
        task: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(4),
  leader: z
    .object({
      agent: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .transform((v) => v ?? undefined),
    })
    .optional()
    .transform((v) => v ?? undefined),
});

type RunTeamInput = z.infer<typeof RunTeamInputSchema>;

export function createRunTeamTool(): Tool<RunTeamInput> {
  return {
    name: 'run_team',
    description:
      '并行委派多个子代理执行独立任务并汇总结果（如同时做代码审查 + 方案设计）。成员 1-4 个，任务应相互独立。返回每个成员的结果与总体统计。',
    inputSchema: RunTeamInputSchema,
    permission: 'ask',
    category: 'exec',
    execute: async (input: RunTeamInput, ctx: ToolContext): Promise<ToolResult> => {
      try {
        const result = await teamService.runTeam(
          input.members,
          ctx.workingDir,
          input.leader !== undefined
            ? { ...(input.leader.agent !== undefined ? { agent: input.leader.agent } : {}) }
            : undefined,
        );
        const lines = [
          `【团队执行汇总】成功 ${result.succeeded} / 失败 ${result.failed}（共 ${result.members.length} 名成员）`,
          '',
          ...result.members.map((member) => {
            const status = member.success ? '✅' : '❌';
            return [
              `${status} ${member.agent}（${Math.round(member.durationMs / 1000)}s）：${member.task.slice(0, 50)}`,
              member.output.trim().slice(0, 2000),
            ].join('\n');
          }),
          ...(result.leaderSummary !== null ? ['', '【领导汇总】', result.leaderSummary] : []),
        ];
        return {
          title: t('tools.runTeam.completed', { count: result.members.length }),
          output: lines.join('\n\n'),
        };
      } catch (err: unknown) {
        return {
          title: t('tools.runTeam.failed'),
          output: `团队执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
