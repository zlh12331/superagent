// （Copyright 2026 Qwen Team，SPDX-License-Identifier: Apache-2.0）的

import { z } from 'zod';
import { logger } from '../../../utils/logger';
import type { LlmClient } from '../llm-client';

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
 *
 * 无状态单例：判定是纯查询效果（side query），不落库、不感知目标状态
 * （goals 表读写全在 goal-service）。
 */
export class GoalJudge {
  constructor(private readonly llmClient: LlmClient) {}

  /**
   * 判定目标是否满足（基于回合转录证据）
   *
   * @param condition 目标条件
   * @param transcript 回合转录文本（调用方累积，见 goal-service：TEXT_DELTA
   *   拼接的助手全文；超 8000 字符截断）
   * @returns 判定结果；任何失败 → 默认 not met（安全语义：判定器不可用
   *   不应误判目标已达成或不可能）
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
      logger.warn({ condition, error: err }, '目标判定失败（默认未满足）');
      return { met: false, reason: '判定器不可用，视为未满足', impossible: false };
    }
  }
}
