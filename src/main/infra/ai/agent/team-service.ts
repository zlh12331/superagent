// （Copyright 2025 Qwen，SPDX-License-Identifier: Apache-2.0）的

import { logger } from '../../../utils/logger';
import { getSubagentManager, type SubagentManager } from './subagent-manager';

/** 团队成员委派（一个成员 = 一个子代理 + 一段任务描述） */
export interface TeamMemberTask {
  /** 子代理名（general / code_review / plan 等） */
  readonly agent: string;
  /** 委派任务 */
  readonly task: string;
}

/** 团队成员结果（成功与失败同构，失败时 output 携带错误说明） */
export interface TeamMemberResult {
  readonly agent: string;
  readonly task: string;
  /** 执行是否成功（失败时 output 为错误信息） */
  readonly success: boolean;
  readonly output: string;
  /** 耗时（毫秒） */
  readonly durationMs: number;
}

/** 团队执行结果（成员明细 + 成败计数 + 可选领导结论） */
export interface TeamRunResult {
  readonly members: readonly TeamMemberResult[];
  /** 成功成员数 */
  readonly succeeded: number;
  /** 失败成员数 */
  readonly failed: number;
  /** 领导汇总结论（提供 leader 时才有；失败为错误说明） */
  readonly leaderSummary: string | null;
}

/** 领导汇总配置（可选启用；缺省不执行领导回合） */
export interface TeamLeaderConfig {
  /** 领导子代理名（默认 general） */
  readonly agent?: string;
}

/**
 * 团队服务（模块单例：多代理并行委派）
 */
export class TeamService {
  /**
   * 构造注入（测试可控；缺省回退模块级单例）
   *
   * manager 省略时每次调用现取 getSubagentManager()，不做构造期快照——
   * 允许单例在 initSubagentManager 完成前先构造。
   */
  constructor(private readonly manager?: SubagentManager) {}

  /**
   * 并行委派团队成员任务并汇总结果
   *
   * - 并发安全：SubagentManager.run 为每次委派分配独立 sessionId，回合事件按
   *   sessionId 过滤，多成员并行不串流
   * - 失败隔离：单成员失败记录错误，不阻断其他成员（Promise.all 内各自 catch）
   * - leader 汇总：可选——成员完成后由领导子代理聚合结论
   *
   * @param members 团队成员委派列表
   * @param workingDir 工作目录
   * @param leader 领导汇总配置（可选；提供则执行领导聚合回合）
   */
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

  /**
   * 领导汇总：成员结果 → 领导子代理聚合 → 团队结论
   *
   * 成员输出逐条截断到 1500 字符后序列化，避免超长成员输出把领导回合的
   * prompt 撑爆。失败（领导回合异常/超时）返回错误说明，不阻断已完成的成员结果。
   */
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

/** 模块级单例（run_team 工具注册时使用） */
export const teamService = new TeamService();
