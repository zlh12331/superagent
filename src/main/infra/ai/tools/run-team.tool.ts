// src/main/infra/ai/tools/run-team.tool.ts
// run_team 工具：模型并行委派多个子代理并汇总（对齐 qwen Team 工具语义）
// ──────────────────────────────────────────────────────────────
// 设计：
// - permission='ask' / category='exec'：成员回合可能产生副作用，保守审批
// - 团队执行 = 并行委派（SubagentManager 按 sessionId 过滤保证并发隔离）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { teamService } from '../agent/team-service';
import type { Tool, ToolContext, ToolResult } from './tool';

/** run_team 入参 */
const RunTeamInputSchema = z.object({
  /** 团队成员委派列表（2-4 名，任务可并行） */
  members: z
    .array(
      z.object({
        /** 子代理名（general / code_review / plan 等） */
        agent: z.string().min(1).max(100),
        /** 委派任务 */
        task: z.string().min(1).max(1000),
      }),
    )
    .min(1)
    .max(4),
  /** 领导汇总配置（可选：成员完成后由领导子代理聚合结论） */
  leader: z
    .object({
      /** 领导子代理名（默认 general） */
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

/**
 * 创建 run_team 工具（依赖模块级 TeamService 单例）
 */
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
        // exactOptionalPropertyTypes：leader.agent 可能为 undefined，条件展开
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
          title: `团队执行完成: ${result.members.length} 名成员`,
          output: lines.join('\n\n'),
        };
      } catch (err: unknown) {
        return {
          title: '团队执行失败',
          output: `团队执行失败：${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
