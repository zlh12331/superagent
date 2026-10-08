// src/main/infra/ai/providers/types.ts
// Provider 路由层类型定义（Code Agent 模板核心扩展点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 ProviderKind 枚举（模型供应商标识）
// - 定义 ProviderDefinition（供应商静态元数据：默认模型 / 是否需要 API Key）
// - 定义 ProviderFactory（创建 LanguageModel 工厂的签名）
//
// 设计（对标 OpenCode 的 provider 路由）：
// - 供应商列表集中注册在 registry.ts，新增供应商 = 在 BUILTIN_DEFINITIONS
//   与 BUILTIN_FACTORIES 常量表中各加一条
// - API Key 按 kind 分 key 存储在 keychain（settings 域已支持）
// - 默认模型/默认供应商从模型领域层派生（builtin-models.ts 单一真源）
// ──────────────────────────────────────────────────────────────

import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';

/**
 * 模型供应商标识（内置 10 家）
 *
 * - deepseek：DeepSeek 官方 API（OpenAI Compatible 协议）
 * - openai：OpenAI 官方 API
 * - anthropic：Anthropic Claude API
 * - ollama：本地 Ollama 服务（OpenAI Compatible 协议，无需 API Key）
 * - moonshot/zhipu/qwen/doubao/siliconflow/openrouter：OpenAI Compatible 协议
 *
 * 扩展新供应商：在 PROVIDER_KINDS 中追加枚举值，并在 registry.ts 的
 * BUILTIN_DEFINITIONS / BUILTIN_FACTORIES 常量表中各加一条（运行时校验在
 * registry.getDefinition——未知 kind 抛错）。
 */
export const PROVIDER_KINDS = [
  'deepseek',
  'openai',
  'anthropic',
  'ollama',
  'moonshot',
  'zhipu',
  'qwen',
  'doubao',
  'siliconflow',
  'openrouter',
] as const;

/** 模型供应商标识 TypeScript 类型 */
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * 供应商静态定义（无状态，可安全共享）
 */
export interface ProviderDefinition {
  /** 供应商标识（keychain key 前缀 + 路由键） */
  readonly kind: ProviderKind;
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
 * 注意：请求超时不由 provider 层控制，由调用方（llm-client / agent 侧
 * turn-assembly）通过 AbortSignal 管理（已有 abort 机制），避免双轨超时语义混乱。
 */
export interface ProviderCreateContext {
  /** API Key（requiresApiKey=false 的供应商可能为 undefined） */
  readonly apiKey: string | undefined;
  /**
   * 显式 baseUrl 覆盖（运行时模型快照携带；undefined = 供应商默认端点）
   *
   * 触发场景：用户手动配置的自定义 OpenAI-compatible 端点。
   */
  readonly baseUrl?: string;
  /**
   * API 协议格式覆盖（运行时模型快照携带；undefined = 按 kind 默认）
   *
   * 仅自定义模型会传非默认值——用户显式选择协议（Chat Completions /
   * Responses / Anthropic Messages）；服务商模式由 kind 决定，不传本字段。
   */
  readonly apiFormat?: ModelApiFormat;
}

/**
 * Provider 工厂签名
 *
 * @param context 创建上下文（apiKey / baseUrl）
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
 * 注册表快照（当前生产零调用、仅单测——settings 域未接线）
 *
 * 显示名不经 main 下发：渲染层以 kind 经 i18n（providers.* / providerLabel）
 * 解析，语言包是唯一真源（2026-10-07 移除 main 侧 displayName 死字段，
 * 消除双源漂移）。
 */
export interface ProviderInfo {
  readonly kind: ProviderKind;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly isDefault: boolean;
}
