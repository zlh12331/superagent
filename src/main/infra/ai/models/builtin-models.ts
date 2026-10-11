// builtin-models.ts：内置模型清单（各供应商预置模型 + 能力/上下文窗口/生成配置）
// ⚠️ P3-50 已知死字段：displayName 在此维护但运行时模型列表未接 UI（技术债台账登记在案）
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from '@code-agent/shared/main';

import type { ProviderKind } from '../providers/types';
import type { ModelEntry } from './types';

export const BUILTIN_MODELS: readonly ModelEntry[] = [
  {
    id: 'deepseek-flash',
    providerKind: 'deepseek',
    displayName: 'DeepSeek V4.1 Flash（多模态）',
    capabilities: {
      reasoning: true,
      vision: true,
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
    displayName: 'DeepSeek Chat（已退役：官方 2026-07-24 停用）',
    capabilities: { contextWindowSize: 64_000, maxOutputTokens: 8_192 },
  },
  {
    id: 'deepseek-reasoner',
    providerKind: 'deepseek',
    displayName: 'DeepSeek Reasoner（已退役：官方 2026-07-24 停用）',
    capabilities: { reasoning: true, contextWindowSize: 64_000, maxOutputTokens: 64_000 },
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
    id: 'glm-5.2',
    providerKind: 'zhipu',
    displayName: 'GLM-5.2（1M 上下文）',
    capabilities: {
      reasoning: true,
      contextWindowSize: 1_000_000,
      maxOutputTokens: 128_000,
    },
    generationConfig: { reasoningEffort: 'max' },
  },
  {
    // 官方契约：GLM-5.3 强制思考，thinking.type 仅接受 enabled（disabled 请求失败）；
    // reasoning_effort 三档 low/high/max 默认 max
    id: 'glm-5.3',
    providerKind: 'zhipu',
    displayName: 'GLM-5.3（强制思考，1M 上下文）',
    capabilities: {
      reasoning: true,
      contextWindowSize: 1_000_000,
      maxOutputTokens: 128_000,
    },
    generationConfig: { reasoningEffort: 'max' },
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
];

/** 各厂商默认模型（只登记深度适配厂商；未登记 kind = 无预设，设置面不展示该厂商） */
export const DEFAULT_MODEL_BY_KIND: Partial<Record<ProviderKind, string>> = {
  deepseek: DEFAULT_MODEL,
  zhipu: 'glm-5.2',
  mimo: 'mimo-v2.6-pro',
};

export const DEFAULT_KIND: ProviderKind = DEFAULT_PROVIDER;
