// src/main/infra/ai/models/builtin-models.ts
// 内置模型定义表（模型级路由的数据源）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 以模型为最小单元定义内置模型（区别于旧设计按供应商定义）
// - 保持与 providers/registry.ts BUILTIN_DEFINITIONS 的默认模型 id 一致
//   （deepseek-v4-flash / gpt-4o / claude-sonnet-4-20250514 / qwen2.5-coder:7b）
//
// 设计（对标 qwen-code modelsConfig + opencode 模型表）：
// - 同一供应商可挂多个模型条目：默认模型（agent 主循环）+ 快模型（fastOnly）
// - 能力元数据（reasoning / vision / contextWindowSize / fastOnly）驱动功能路由
// ──────────────────────────────────────────────────────────────

import type { ProviderKind } from '../providers/types';
import type { ModelEntry } from './types';

/** 内置模型条目表 */
export const BUILTIN_MODELS: readonly ModelEntry[] = [
  // ── DeepSeek（默认供应商，OpenAI Compatible 协议）──
  // 官方文档：https://api-docs.deepseek.com/zh-cn/
  // v4 系列思考模式默认开启；默认模型为 flash（成本/速度优先），
  // pro 作为高性能档供用户手动选择；思考强度默认 max
  {
    id: 'deepseek-v4-flash',
    providerKind: 'deepseek',
    displayName: 'DeepSeek V4 Flash',
    capabilities: {
      reasoning: true,
      contextWindowSize: 1_000_000,
      maxOutputTokens: 384_000,
    },
    // 官方默认思考强度即 high，此处显式声明为 max（用户偏好）
    generationConfig: { reasoningEffort: 'max' },
  },
  {
    id: 'deepseek-v4-pro',
    providerKind: 'deepseek',
    displayName: 'DeepSeek V4 Pro（高性能）',
    capabilities: {
      reasoning: true,
      contextWindowSize: 1_000_000,
      maxOutputTokens: 384_000,
    },
    generationConfig: { reasoningEffort: 'max' },
  },

  // ── DeepSeek 旧版模型（兼容既有配置，非默认）──
  {
    id: 'deepseek-chat',
    providerKind: 'deepseek',
    displayName: 'DeepSeek Chat（旧版兼容）',
    capabilities: { contextWindowSize: 64_000, maxOutputTokens: 8_192 },
  },
  {
    id: 'deepseek-reasoner',
    providerKind: 'deepseek',
    displayName: 'DeepSeek Reasoner（旧版兼容）',
    // 输出上限含思维链 token
    capabilities: { reasoning: true, contextWindowSize: 64_000, maxOutputTokens: 64_000 },
  },

  // ── OpenAI ──
  {
    id: 'gpt-4o',
    providerKind: 'openai',
    displayName: 'GPT-4o',
    capabilities: { vision: true, contextWindowSize: 128_000, maxOutputTokens: 16_384 },
  },
  {
    id: 'gpt-4o-mini',
    providerKind: 'openai',
    displayName: 'GPT-4o mini（快模型）',
    capabilities: {
      vision: true,
      contextWindowSize: 128_000,
      maxOutputTokens: 16_384,
      fastOnly: true,
    },
  },

  // ── Anthropic ──
  {
    id: 'claude-sonnet-4-20250514',
    providerKind: 'anthropic',
    displayName: 'Claude Sonnet 4',
    capabilities: { vision: true, contextWindowSize: 200_000, maxOutputTokens: 64_000 },
  },
  {
    id: 'claude-3-5-haiku-20241022',
    providerKind: 'anthropic',
    displayName: 'Claude Haiku（快模型）',
    capabilities: {
      vision: true,
      contextWindowSize: 200_000,
      maxOutputTokens: 64_000,
      fastOnly: true,
    },
  },

  // ── Ollama（本地，无需 API Key）──
  {
    id: 'qwen2.5-coder:7b',
    providerKind: 'ollama',
    displayName: 'Qwen2.5 Coder 7B（本地）',
    // 本地推理保守上限（默认 num_predict 受限）
    capabilities: { contextWindowSize: 32_000, maxOutputTokens: 8_192 },
  },
  {
    id: 'qwen2.5:7b',
    providerKind: 'ollama',
    displayName: 'Qwen2.5 7B（本地快模型）',
    capabilities: { contextWindowSize: 32_000, maxOutputTokens: 8_192, fastOnly: true },
  },
  // Moonshot Kimi（OpenAI Compatible 协议）
  {
    id: 'kimi-k2-0711-preview',
    providerKind: 'moonshot',
    displayName: 'Kimi K2 0711 Preview',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  // 智谱 GLM（OpenAI Compatible 协议）
  {
    id: 'glm-4.6',
    providerKind: 'zhipu',
    displayName: 'GLM-4.6',
    capabilities: {
      contextWindowSize: 200000,
      maxOutputTokens: 8192,
    },
  },
  // 通义千问（OpenAI Compatible 协议）
  {
    id: 'qwen3-coder-plus',
    providerKind: 'qwen',
    displayName: 'Qwen3 Coder Plus',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  // 豆包（火山方舟）（OpenAI Compatible 协议）
  {
    id: 'doubao-seed-1-6-250615',
    providerKind: 'doubao',
    displayName: 'Doubao Seed 1.6',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  // 硅基流动（OpenAI Compatible 协议）
  {
    id: 'deepseek-ai/DeepSeek-V3.1',
    providerKind: 'siliconflow',
    displayName: 'DeepSeek V3.1 (SF)',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  // OpenRouter（OpenAI Compatible 协议）
  {
    id: 'deepseek/deepseek-chat',
    providerKind: 'openrouter',
    displayName: 'DeepSeek Chat (OR)',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
];

/**
 * 各供应商默认模型 id（未指定模型时的解析目标）
 *
 * - deepseek 默认 v4-flash（2026 官方主力模型，1M 上下文 + 思考模式）
 * - 单一真源：providers/registry.ts 的 BUILTIN_DEFINITIONS.defaultModel 从此处派生
 *   （避免双源维护导致 getModel 与 getAIProvider 路由分裂）
 */
export const DEFAULT_MODEL_BY_KIND: Record<ProviderKind, string> = {
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  ollama: 'qwen2.5-coder:7b',
  moonshot: 'kimi-k2-0711-preview',
  zhipu: 'glm-4.6',
  qwen: 'qwen3-coder-plus',
  doubao: 'doubao-seed-1-6-250615',
  siliconflow: 'deepseek-ai/DeepSeek-V3.1',
  openrouter: 'deepseek/deepseek-chat',
};

/**
 * 全局默认供应商（未指定模型时的最终兑底）
 *
 * 单一真源：providers/registry.ts 的 isDefault 标记从此处派生。
 */
export const DEFAULT_KIND: ProviderKind = 'deepseek';
