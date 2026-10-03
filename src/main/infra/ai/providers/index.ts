// src/main/infra/ai/providers/index.ts
// Provider 路由层统一入口（目录级桶出口）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出 ProviderKind / ProviderDefinition / ProviderInfo 等类型
// - 导出 ProviderRegistry 类与内置注册表单例（providerRegistry）
//
// 桶消费方：
// - ai-provider：工厂装配与 kind 级缓存（getDefaultKind/getDefinition/
//   createFactory/toKeychainKey）
// - generation-options：providerOptions 键经 getProviderName 收敛
// - 单测：new ProviderRegistry() 注入自定义定义
// （providerRegistry.list() 当前生产零调用，仅单测——原注释的「settings 域
//   列出可选供应商」未接线）
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
