// src/main/infra/ai/llm-client/index.ts
// LLM 客户端统一入口
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 LlmClient 类与依赖类型
// - 导出重试层（retryWithBackoff / isRetryableError / getErrorStatus）
//
// 注意：LlmClient 单例在 ai-provider.ts 装配（依赖注入 createProviderFactory），
// 本文件不创建实例，避免循环依赖。
// ──────────────────────────────────────────────────────────────

export type {
  LlmClientDeps,
  LlmGenerateJsonOptions,
  LlmGenerateTextOptions,
  LlmGenerateTextResult,
} from './llm-client';
export { LlmClient } from './llm-client';
export type { RetryAttemptInfo, RetryOptions } from './retry';
export { getErrorStatus, getRetryAfterDelayMs, isRetryableError, retryWithBackoff } from './retry';
