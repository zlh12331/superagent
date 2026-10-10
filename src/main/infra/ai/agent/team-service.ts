import { logger } from '../../../utils/logger';
import { getSubagentManager, type SubagentManager } from './subagent-manager';

export interface TeamMemberTask {
  readonly agent: string;
  readonly task: string;
}

export interface TeamMemberResult {
  readonly agent: string;
  readonly task: string;
  readonly success: boolean;
  readonly output: string;
  readonly durationMs: number;
}

export interface TeamRunResult {
  readonly members: readonly TeamMemberResult[];
  readonly succeeded: number;
  readonly failed: number;
  readonly leaderSummary: string | null;
}

export interface TeamLeaderConfig {
  readonly agent?: string;
}

export class TeamService {
  constructor(private readonly manager?: SubagentManager) {}

  async runTeam(
    members: readonly TeamMemberTask[],
    workingDir: string,
    leader?: TeamLeaderConfig,
  ): Promise<TeamRunResult> {
    const manager = this.manager ?? getSubagentManager();
    const results = await Promise.all(
      members.map(async (member) => {
        const startTime = Date.now();
        try {
          const result = await manager.run(member.agent, member.task, workingDir);
          return {
            agent: member.agent,
            task: member.task,
            success: true,
            output: result.output,
            durationMs: result.durationMs,
          } satisfies TeamMemberResult;
        } catch (err: unknown) {
          logger.warn({ agent: member.agent, error: err }, '团队成员执行失败');
          return {
            agent: member.agent,
            task: member.task,
            success: false,
            output: `成员执行失败：${err instanceof Error ? err.message : String(err)}`,
            durationMs: Date.now() - startTime,
          } satisfies TeamMemberResult;
        }
      }),
    );

    let leaderSummary: string | null = null;
    if (leader !== undefined) {
      leaderSummary = await this.runLeaderSummary(leader.agent ?? 'general', results, workingDir);
    }

    return {
      members: results,
      succeeded: results.filter((r) => r.success).length,
      failed: results.filter((r) => !r.success).length,
      leaderSummary,
    };
  }

  private async runLeaderSummary(
    agent: string,
    members: readonly TeamMemberResult[],
    workingDir: string,
  ): Promise<string> {
    const manager = this.manager ?? getSubagentManager();
    const serialized = members
      .map((m) => `【${m.agent}】${m.success ? '成功' : '失败'}\n${m.output.trim().slice(0, 1500)}`)
      .join('\n\n');
    try {
      const result = await manager.run(
        agent,
        `以下是团队成员的执行结果，请汇总为团队结论（整体评估 + 关键发现 + 待办事项）：\n\n${serialized}`,
        workingDir,
      );
      return result.hasOutput ? result.output : '领导汇总完成但无文本输出。';
    } catch (err: unknown) {
      logger.warn({ leader: agent, error: err }, '领导汇总执行失败');
      return `领导汇总失败：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

export const teamService = new TeamService();
