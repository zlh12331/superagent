// builtin-models.ts：内置模型清单（各供应商预置模型 + 能力/上下文窗口/生成配置）
// ⚠️ P3-50 已知死字段：displayName 在此维护但运行时模型列表未接 UI（技术债台账登记在案）
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '@code-agent/shared/main';

import type { ProviderKind } from '../providers/types';
import type { ModelEntry } from './types';

export const BUILTIN_MODELS: readonly ModelEntry[] = [
  {
    id: 'deepseek-v4-flash',
    providerKind: 'deepseek',
    displayName: 'DeepSeek V4 Flash',
    capabilities: {
      reasoning: true,
      contextWindowSize: 1_000_000,
      maxOutputTokens: 384_000,
    },
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
    capabilities: { reasoning: true, contextWindowSize: 64_000, maxOutputTokens: 64_000 },
  },

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

  {
    id: 'qwen2.5-coder:7b',
    providerKind: 'ollama',
    displayName: 'Qwen2.5 Coder 7B（本地）',
    capabilities: { contextWindowSize: 32_000, maxOutputTokens: 8_192 },
  },
  {
    id: 'qwen2.5:7b',
    providerKind: 'ollama',
    displayName: 'Qwen2.5 7B（本地快模型）',
    capabilities: { contextWindowSize: 32_000, maxOutputTokens: 8_192, fastOnly: true },
  },
  {
    id: 'kimi-k2-0711-preview',
    providerKind: 'moonshot',
    displayName: 'Kimi K2 0711 Preview',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  {
    id: 'glm-4.6',
    providerKind: 'zhipu',
    displayName: 'GLM-4.6',
    capabilities: {
      reasoning: true,
      contextWindowSize: 200000,
      maxOutputTokens: 8192,
    },
    generationConfig: { reasoningEffort: 'high' },
  },
  {
    id: 'glm-5.1',
    providerKind: 'zhipu',
    displayName: 'GLM-5.1',
    capabilities: {
      reasoning: true,
      contextWindowSize: 200_000,
      maxOutputTokens: 128_000,
    },
    generationConfig: { reasoningEffort: 'high' },
  },
  {
    id: 'mimo-v2.6-flash',
    providerKind: 'mimo',
    displayName: 'MiMo V2.6 Flash',
    capabilities: {
      reasoning: true,
      contextWindowSize: 131072,
      maxOutputTokens: 131072,
    },
    generationConfig: { reasoningEffort: 'high' },
  },
  {
    id: 'mimo-v2.6-pro',
    providerKind: 'mimo',
    displayName: 'MiMo V2.6 Pro',
    capabilities: {
      reasoning: true,
      contextWindowSize: 131072,
      maxOutputTokens: 131072,
    },
    generationConfig: { reasoningEffort: 'high' },
  },
  {
    id: 'mimo-v2.6-pro-ultraspeed',
    providerKind: 'mimo',
    displayName: 'MiMo V2.6 Pro UltraSpeed',
    capabilities: {
      reasoning: true,
      contextWindowSize: 131072,
      maxOutputTokens: 131072,
    },
    generationConfig: { reasoningEffort: 'high' },
  },
  {
    id: 'qwen3-coder-plus',
    providerKind: 'qwen',
    displayName: 'Qwen3 Coder Plus',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  {
    id: 'doubao-seed-1-6-250615',
    providerKind: 'doubao',
    displayName: 'Doubao Seed 1.6',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
  {
    id: 'deepseek-ai/DeepSeek-V3.1',
    providerKind: 'siliconflow',
    displayName: 'DeepSeek V3.1 (SF)',
    capabilities: {
      contextWindowSize: 131072,
      maxOutputTokens: 8192,
    },
  },
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

export const DEFAULT_MODEL_BY_KIND: Record<ProviderKind, string> = {
  deepseek: DEFAULT_MODEL,
  openai: 'gpt-4o',
  anthropic: 'claude-sonnet-4-20250514',
  ollama: 'qwen2.5-coder:7b',
  moonshot: 'kimi-k2-0711-preview',
  zhipu: 'glm-4.6',
  qwen: 'qwen3-coder-plus',
  doubao: 'doubao-seed-1-6-250615',
  siliconflow: 'deepseek-ai/DeepSeek-V3.1',
  openrouter: 'deepseek/deepseek-chat',
  mimo: 'mimo-v2.6-pro',
};

export const DEFAULT_KIND: ProviderKind = DEFAULT_PROVIDER;
