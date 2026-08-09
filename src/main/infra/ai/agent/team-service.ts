// src/main/infra/ai/team-service.ts
// 团队协作：多代理并行委派 + 结果汇总（对齐 qwen team 语义收敛）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 并行委派多个成员子代理（复用 SubagentManager.run）
// - 结果汇总（每个成员输出 + 状态）+ 失败隔离（单成员失败不阻断团队）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/agents/team/
// （Copyright 2025 Qwen，SPDX-License-Identifier: Apache-2.0）的
// TeamManager（团队协调）+ team-events（成员事件）语义，按我们的技术栈
// 收敛重写：
// - 移除 mailbox / identity / leaderPermissionBridge（qwen 专有消息总线，
//   强耦合不搬运；我们的 onTurnEvent 总线按 sessionId 过滤已保证并发隔离）
// - 收敛为"领导委派 → 成员并行执行 → 结构化汇总"（领导汇总后置）
// ──────────────────────────────────────────────────────────────

import { logger } from '../../../utils/logger';
import { getSubagentManager, type SubagentManager } from './subagent-manager';

/** 团队成员委派 */
export interface TeamMemberTask {
  /** 子代理名（general / code_review / plan 等） */
  readonly agent: string;
  /** 委派任务 */
  readonly task: string;
}

/** 团队成员结果 */
export interface TeamMemberResult {
  readonly agent: string;
  readonly task: string;
  /** 执行是否成功（失败时 output 为错误信息） */
  readonly success: boolean;
  readonly output: string;
  /** 耗时（毫秒） */
  readonly durationMs: number;
}

/** 团队执行结果 */
export interface TeamRunResult {
  readonly members: readonly TeamMemberResult[];
  /** 成功成员数 */
  readonly succeeded: number;
  /** 失败成员数 */
  readonly failed: number;
  /** 领导汇总结论（提供 leader 时才有；失败为错误说明） */
  readonly leaderSummary: string | null;
}

/** 领导汇总配置 */
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
   */
  constructor(private readonly manager?: SubagentManager) {}

  /**
   * 并行委派团队成员任务并汇总结果
   *
   * - 并发安全：SubagentManager.run 按 sessionId 过滤回合事件，多成员并行不串流
   * - 失败隔离：单成员失败记录错误，不阻断其他成员
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
          // 失败隔离：记录错误不阻断团队
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

    // leader 汇总：成员结果序列化 → 领导子代理聚合回合
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
   * 失败（领导回合异常/超时）返回错误说明，不阻断已完成的成员结果。
   */
  private async runLeaderSummary(
    agent: string,
    members: readonly TeamMemberResult[],
    workingDir: string,
  ): Promise<string> {
    const manager = this.manager ?? getSubagentManager();
    // 成员结果序列化（给领导子代理的结构化输入）
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
