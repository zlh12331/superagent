// goal-judge.ts：目标达成判定器——LLM 按对话转录判 met/impossible，JSON 输出 zod 校验
import { z } from 'zod';
import { logger } from '../../../utils/logger';
import type { LlmClient } from '../llm-client';

/** 判定结果：met=达成 / impossible=不可能达成（自相矛盾或资源不可用——阻止无意义重试） */
export interface GoalJudgement {
  readonly met: boolean;
  readonly reason: string;
  readonly impossible: boolean;
}

const JudgementOutputSchema = z.object({
  met: z.boolean(),
  reason: z.string().max(500),
  impossible: z.boolean().optional(),
});

const JUDGE_SYSTEM_PROMPT = [
  '你是目标完成判定器。根据对话转录判断用户目标是否达成：',
  '- met=true：转录中有明确证据证明条件已满足',
  '- met=false：证据不足或条件未满足（默认）',
  '- impossible=true：条件不可能达成（自相矛盾/依赖不可用资源/已穷尽合理方案）',
  '仅返回 JSON：{"met": boolean, "reason": "引用转录证据的理由", "impossible": boolean}',
].join('\n');

export class GoalJudge {
  constructor(private readonly llmClient: LlmClient) {}

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
