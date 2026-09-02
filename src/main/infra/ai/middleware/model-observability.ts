// src/main/infra/ai/middleware/model-observability.ts
// 模型调用级统一观测中间件（LanguageModelMiddleware）
// ──────────────────────────────────────────────────────────────
// 职责：
// - wrapGenerate / wrapStream 处统一记录每次模型调用的耗时与结果
// - 成功路径打 debug（高频场景不进生产落盘，避免噪声）
// - 失败路径打 warn（生产可查：任何模型调用失败都在此集中可见）
//
// 接入方式：
// - 常规链路（agent 主回合 / chat / side query）：LlmClient.getModel 内 wrap，
//   per-model 缓存的就是 wrapped 实例，所有调用方零改动即可获得观测
// - 覆盖路径（settings 测试连接等显式 kind/apiKey 覆盖）不观察测：
//   短线低频诊断调用，错误已由 settings UI 独立展示；且覆盖路径走
//   providerRegistry.createFactory 直出（不经 LlmClient），包装会引入
//   对模型接口形态的无谓耦合，观测收益趋零
//
// 边界（实事求是）：
// - wrapStream 的 doStream 只 resolve 到「流头建立」，latencyMs 语义是
//   首响应建立耗时（TTFB），不是整个流传输时长（流中途错误由消费端守卫）
// - 本中间件不吞错、不改参数、不注入信号：只观测，错误原样抛给上层
// ──────────────────────────────────────────────────────────────

import type { LanguageModelMiddleware } from 'ai';
import { logger } from '../../../utils/logger';

/** 提取错误可读信息（保持与原 logger 用法一致，不吞真实错误对象） */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 模型调用级观测中间件（模块级单例常量）
 *
 * 挂到 getModel 出口后，agent 主回合、chat、side query 的每个模型调用
 * 都会经过这里打点：provider / modelId / 耗时 / token 用量。
 */
export const modelObservabilityMiddleware: LanguageModelMiddleware = {
  wrapGenerate({ doGenerate, model }) {
    const startedAt = Date.now();
    // doGenerate 为 0 参闭包：wrapLanguageModel 已捕获转译后的 params
    return doGenerate().then(
      (result) => {
        logger.debug(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            ...(result.usage?.inputTokens !== undefined
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(result.usage?.outputTokens !== undefined
              ? { outputTokens: result.usage.outputTokens }
              : {}),
          },
          '模型生成调用完成',
        );
        return result;
      },
      (error) => {
        logger.warn(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          },
          '模型生成调用失败',
        );
        throw error;
      },
    );
  },

  wrapStream({ doStream, model }) {
    const startedAt = Date.now();
    // doStream 为 0 参闭包：wrapLanguageModel 已捕获转译后的 params
    return doStream().then(
      (result) => {
        logger.debug(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
          },
          '模型流式调用已建立',
        );
        return result;
      },
      (error) => {
        logger.warn(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          },
          '模型流式调用启动失败',
        );
        throw error;
      },
    );
  },
};
