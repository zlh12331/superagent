// src/main/infra/ai/providers/types.ts
// Provider 路由层类型定义（Code Agent 模板核心扩展点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 ProviderKind 枚举（模型供应商标识）
// - 定义 ProviderDefinition（供应商静态元数据：显示名 / 默认模型 / 是否需要 API Key）
// - 定义 ProviderFactory（创建 LanguageModel 工厂的签名）
//
// 设计（对标 OpenCode 的 provider 路由）：
// - 供应商列表集中注册在 registry.ts，新增供应商 = 新增一条定义 + 一个工厂
// - API Key 按 kind 分 key 存储在 keychain（settings 域已支持）
// - getModel(kind, modelId) 由调用方（chat-service / agent-service）指定供应商，
//   默认回落到 config 中配置的默认供应商，保持向后兼容
// ──────────────────────────────────────────────────────────────

import type { LanguageModel } from 'ai';

/**
 * 模型供应商标识
 *
 * - deepseek：DeepSeek 官方 API（OpenAI Compatible 协议）
 * - openai：OpenAI 官方 API
 * - anthropic：Anthropic Claude API
 * - ollama：本地 Ollama 服务（OpenAI Compatible 协议，无需 API Key）
 *
 * 扩展新供应商：在 ProviderKindSchema / ProviderKind 中追加枚举值，
 * 并在 registry.ts 的 registerBuiltinProviders 中注册定义与工厂。
 */
export const PROVIDER_KINDS = ['deepseek', 'openai', 'anthropic', 'ollama'] as const;

/** 模型供应商标识 TypeScript 类型 */
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * 供应商静态定义（无状态，可安全共享）
 */
export interface ProviderDefinition {
  /** 供应商标识（keychain key 前缀 + 路由键） */
  readonly kind: ProviderKind;
  /** 显示名称（设置 UI 展示用） */
  readonly displayName: string;
  /** 默认模型 id（未指定模型时使用） */
  readonly defaultModel: string;
  /** 是否需要 API Key（ollama 等本地服务不需要） */
  readonly requiresApiKey: boolean;
  /** 是否默认启用（兜底路由目标） */
  readonly isDefault?: boolean;
}

/**
 * 供应商创建选项
 *
 * 由 registry 在创建 provider 时注入。
 * 注意：请求超时不由 provider 层控制，由调用方（chat-service / agent-service）
 * 通过 AbortSignal 管理（已有 abort 机制），避免双轨超时语义混乱。
 */
export interface ProviderCreateContext {
  /** API Key（requiresApiKey=false 的供应商可能为 undefined） */
  readonly apiKey: string | undefined;
}

/**
 * Provider 工厂签名
 *
 * @param context 创建上下文（apiKey / timeout）
 * @returns LanguageModel 工厂：调用 factory(modelId) 返回 LanguageModel 实例
 */
export type ProviderFactory = (
  context: ProviderCreateContext,
) => (modelId: string) => LanguageModel;

/**
 * 已注册的 Provider 条目（定义 + 工厂）
 */
export interface RegisteredProvider {
  readonly definition: ProviderDefinition;
  readonly factory: ProviderFactory;
}

/**
 * 注册表快照（供 settings 域列出可选供应商）
 */
export interface ProviderInfo {
  readonly kind: ProviderKind;
  readonly displayName: string;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly isDefault: boolean;
}
