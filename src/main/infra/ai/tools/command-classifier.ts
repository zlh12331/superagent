// （Copyright 2025 Qwen Team，SPDX-License-Identifier: Apache-2.0）的两阶段

import { z } from 'zod';
import { logger } from '../../../utils/logger';
import type { LlmClient } from '../llm-client';

/** 分类判定：safe 自动放行 / dangerous 拦截 / unknown 降级 ask */
export type CommandVerdict = 'safe' | 'dangerous' | 'unknown';

/** 分类结果 */
export interface CommandClassification {
  readonly verdict: CommandVerdict;
  /** 判定说明（unknown 时记录失败原因） */
  readonly reason: string;
}

/** 分类输出 schema（generateJson 结构化约束） */
const ClassificationOutputSchema = z.object({
  /** 命令是否安全（只读/无害）；false = 应拦截 */
  safe: z.boolean(),
  /** 判定理由（一句话） */
  reason: z.string().max(200),
});

/** 分类提示词（系统）：判定命令安全性 */
const CLASSIFIER_SYSTEM_PROMPT = [
  '你是命令安全分类器。判断 shell 命令是否安全：',
  '- safe：只读或无副作用（查询、查看、构建产物查看等）',
  '- unsafe：有副作用但常见可接受（安装依赖、构建、测试等）→ 返回 safe=false 但 reason 标注"常见操作"',
  '- 危险：删除/覆盖数据、网络下载执行、权限提升、逃逸沙箱等 → 返回 safe=false',
  '仅返回 JSON：{"safe": boolean, "reason": "一句话理由"}',
].join('\n');

/**
 * 命令安全分类器（依赖 LlmClient 注入，可替换为 fake）
 *
 * 生产装配方 = service-container（new PermissionService 时注入
 * new CommandClassifier(llmClient)）——auto 模式 exec 命令的分层决策消费。
 */
export class CommandClassifier {
  /** 会话内缓存：command → 判定（防模型每轮重复调用重复计费） */
  private readonly cache = new Map<string, CommandClassification>();
  /** 缓存上限（防无限增长） */
  private static readonly CACHE_LIMIT = 200;

  constructor(private readonly llmClient: LlmClient) {}

  /**
   * 分类命令安全性（fail-closed：任何失败 → unknown）
   *
   * @param command 待分类命令
   * @param userPrompt 用户原始 prompt（分类上下文，可选）
   * @param signal 超时/中断信号（CLASSIFIER_TIMEOUT_MS 由调用方组合）
   */
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

  /** 清空缓存（当前无生产调用方，预留能力——审批模式切换重置的是拒绝
   * 计数，不清分类缓存；本方法供未来消费方） */
  clearCache(): void {
    this.cache.clear();
  }
}
