// src/main/infra/ai/goal-judge.ts
// 目标完成判定器（LLM 判定，默认 not met）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 回合结束后判定会话目标 condition 是否满足（基于回合转录证据）
// - 默认 not met：证据不足/判定失败 → 不满足（对齐 qwen goalJudge）
//
// 借鉴声明：
// 本模块参考 qwen-code 参考项目 packages/core/src/goals/goalJudge.ts
// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的
// 判定语义（transcript 证据 + 默认 not met + impossible 判定），按我们的
// 技术栈收敛重写：
// - 移除 @google/genai / Config / transcript 构造（强耦合不搬运）
// - 收敛为单次判定：回合转录文本（user/assistant 消息）作为证据输入
// - 结构化输出用 generateJson（{ met, reason, impossible }）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';
import { logger } from '../../utils/logger';
import type { LlmClient } from './llm-client';

/** 目标判定结果 */
export interface GoalJudgement {
  /** 是否满足目标条件 */
  readonly met: boolean;
  /** 判定理由（引用转录证据） */
  readonly reason: string;
  /** 是否判定为不可能达成（永不满足） */
  readonly impossible: boolean;
}

/** 判定输出 schema */
const JudgementOutputSchema = z.object({
  /** 是否满足（false = 未满足或证据不足） */
  met: z.boolean(),
  /** 判定理由（引用转录证据） */
  reason: z.string().max(500),
  /** 是否不可能达成（自相矛盾/依赖不可用资源/穷尽合理方案） */
  impossible: z.boolean().optional(),
});

/** 判定系统提示词（语义对齐 qwen goalJudge：证据不足默认未满足） */
const JUDGE_SYSTEM_PROMPT = [
  '你是目标完成判定器。根据对话转录判断用户目标是否达成：',
  '- met=true：转录中有明确证据证明条件已满足',
  '- met=false：证据不足或条件未满足（默认）',
  '- impossible=true：条件不可能达成（自相矛盾/依赖不可用资源/已穷尽合理方案）',
  '仅返回 JSON：{"met": boolean, "reason": "引用转录证据的理由", "impossible": boolean}',
].join('\n');

/**
 * 目标完成判定器（依赖 LlmClient 注入）
 */
export class GoalJudge {
  constructor(private readonly llmClient: LlmClient) {}

  /**
   * 判定目标是否满足（基于回合转录证据）
   *
   * @param condition 目标条件
   * @param transcript 回合转录（user/assistant 消息文本）
   * @returns 判定结果；任何失败 → 默认 not met（安全）
   */
  async judge(condition: string, transcript: string): Promise<GoalJudgement> {
    try {
      const output = await this.llmClient.generateJson({
        schema: JudgementOutputSchema,
        prompt: [
          `目标条件：${condition}`,
          `对话转录：\n${transcript.slice(0, 8000)}`,
          '请判定目标是否达成（仅 JSON 输出）。',
        ].join('\n'),
        system: JUDGE_SYSTEM_PROMPT,
        maxAttempts: 1,
      });
      return {
        met: output.met,
        reason: output.reason,
        impossible: output.impossible === true,
      };
    } catch (err: unknown) {
      // 判定失败 → 默认 not met（安全）
      logger.warn({ condition, error: err }, '目标判定失败（默认未满足）');
      return { met: false, reason: '判定器不可用，视为未满足', impossible: false };
    }
  }
}
