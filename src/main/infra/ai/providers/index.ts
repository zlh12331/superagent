// src/main/infra/ai/providers/index.ts
// Provider 路由层统一入口
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 ProviderKind / ProviderDefinition / ProviderInfo 等类型
// - 导出 ProviderRegistry 类与内置注册表单例（registryInstance）
//
// 消费方：
// - ai-provider.ts：getModel(kind, modelId) 路由到对应供应商
// - settings 域：列出可选供应商（registryInstance.list()）
// - 测试：new ProviderRegistry() 注入自定义定义
// ──────────────────────────────────────────────────────────────

import { ProviderRegistry } from './registry';
import type {
  ProviderCreateContext,
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
} from './types';

export { getProviderName, ProviderRegistry, toKeychainKey } from './registry';
export { PROVIDER_KINDS } from './types';
export type {
  ProviderCreateContext,
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
};

/** 内置 Provider 注册表单例（应用全局唯一） */
export const providerRegistry = new ProviderRegistry();
