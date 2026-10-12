// command-classifier.ts：命令安全分类器——LLM 判 safe/dangerous/unknown（ask 模式下审批弹窗文案用）
import { z } from 'zod';
import { logger } from '../../../utils/logger';
import type { LlmClient } from '../llm-client';

export type CommandVerdict = 'safe' | 'dangerous' | 'unknown';

export interface CommandClassification {
  readonly verdict: CommandVerdict;
  readonly reason: string;
}

const ClassificationOutputSchema = z.object({
  safe: z.boolean(),
  reason: z.string().max(200),
});

const CLASSIFIER_SYSTEM_PROMPT = [
  '你是命令安全分类器。判断 shell 命令是否安全：',
  '- safe：只读或无副作用（查询、查看、构建产物查看等）',
  '- unsafe：有副作用但常见可接受（安装依赖、构建、测试等）→ 返回 safe=false 但 reason 标注"常见操作"',
  '- 危险：删除/覆盖数据、网络下载执行、权限提升、逃逸沙箱等 → 返回 safe=false',
  '仅返回 JSON：{"safe": boolean, "reason": "一句话理由"}',
].join('\n');

export class CommandClassifier {
  private readonly cache = new Map<string, CommandClassification>();
  private static readonly CACHE_LIMIT = 200;

  constructor(private readonly llmClient: LlmClient) {}

  async classify(
    command: string,
    userPrompt?: string,
    signal?: AbortSignal,
  ): Promise<CommandClassification> {
    const cached = this.cache.get(command);
    if (cached !== undefined) {
      return cached;
    }

    let result: CommandClassification;
    try {
      const output = await this.llmClient.generateJson({
        schema: ClassificationOutputSchema,
        prompt: [
          `命令：${command}`,
          ...(userPrompt !== undefined && userPrompt.trim().length > 0
            ? [`用户意图：${userPrompt.slice(0, 300)}`]
            : []),
          '请判定该命令是否安全（仅 JSON 输出）。',
        ].join('\n'),
        system: CLASSIFIER_SYSTEM_PROMPT,
        maxAttempts: 1,
        ...(signal !== undefined ? { signal } : {}),
      });
      result = {
        verdict: output.safe ? 'safe' : 'dangerous',
        reason: output.reason,
      };
    } catch (err: unknown) {
      logger.warn({ command, error: err }, '命令分类失败（fail-closed：降级拦截）');
      result = { verdict: 'unknown', reason: '分类器不可用，降级人工确认' };
    }

    while (this.cache.size >= CommandClassifier.CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.cache.delete(oldest);
    }
    this.cache.set(command, result);
    return result;
  }

  clearCache(): void {
    this.cache.clear();
  }
}
