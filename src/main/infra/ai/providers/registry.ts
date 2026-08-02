// src/main/infra/ai/providers/registry.ts
// Provider 注册表（Code Agent 模板核心扩展点）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中注册内置供应商（deepseek / openai / anthropic / ollama）
// - 提供按 kind 查找定义与创建 LanguageModel 工厂的入口
// - 提供注册表快照（settings 域列出可选供应商用）
//
// 设计（对标 OpenCode 的 provider 路由）：
// - 新增供应商 = 新增一个 ProviderDefinition + 一个 ProviderFactory，
//   在 registerBuiltinProviders 中追加一行注册即可
// - deepseek / ollama 复用 OpenAI Compatible 协议（@ai-sdk/openai-compatible）
// - openai 使用官方 @ai-sdk/openai，anthropic 使用官方 @ai-sdk/anthropic
// - 每个供应商的 API Key 独立存储（keychain，key 前缀 = kind）
// ──────────────────────────────────────────────────────────────

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import type {
  ProviderDefinition,
  ProviderFactory,
  ProviderInfo,
  ProviderKind,
  RegisteredProvider,
} from './types';

/**
 * 默认 API Key 前缀（与早期版本 keychain key 命名保持一致）
 *
 * keychain key 命名规则：'<provider-kind>-api-key'
 * - deepseek → 'deepseek-api-key'
 * - openai → 'openai-api-key'
 * - anthropic → 'anthropic-api-key'
 * - ollama → 无需 API Key（本地服务）
 */
export function toKeychainKey(kind: ProviderKind): string {
  return `${kind}-api-key`;
}

/**
 * 内置供应商定义表
 *
 * isDefault 标记默认路由目标（当前为 deepseek，保持向后兼容）。
 */
const BUILTIN_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    kind: 'deepseek',
    displayName: 'DeepSeek',
    defaultModel: 'deepseek-chat',
    requiresApiKey: true,
    isDefault: true,
  },
  {
    kind: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o',
    requiresApiKey: true,
  },
  {
    kind: 'anthropic',
    displayName: 'Anthropic Claude',
    defaultModel: 'claude-sonnet-4-20250514',
    requiresApiKey: true,
  },
  {
    kind: 'ollama',
    displayName: 'Ollama (Local)',
    defaultModel: 'qwen2.5-coder:7b',
    requiresApiKey: false,
  },
];

/**
 * 内置供应商工厂表
 *
 * 每个工厂返回 (modelId) => LanguageModel 的工厂函数。
 * baseURL 可被 .env 覆盖（DEEPSEEK_API_BASE / OPENAI_API_BASE 等），
 * 便于自托管网关 / 代理场景。
 */
const BUILTIN_FACTORIES: Record<ProviderKind, ProviderFactory> = {
  deepseek: ({ apiKey }) => {
    // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
    const baseUrl = process.env['DEEPSEEK_API_BASE'] ?? 'https://api.deepseek.com';
    return createOpenAICompatible({
      name: 'deepseek',
      baseURL: `${baseUrl}/v1`,
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段（ollama 等本地场景）
      ...(apiKey !== undefined ? { apiKey } : {}),
      includeUsage: true,
    }) as unknown as (modelId: string) => LanguageModel;
  },
  openai: ({ apiKey }) => {
    // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
    const baseUrl = process.env['OPENAI_API_BASE'] ?? 'https://api.openai.com/v1';
    return createOpenAI({
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段
      ...(apiKey !== undefined ? { apiKey } : {}),
      baseURL: baseUrl,
    }) as unknown as (modelId: string) => LanguageModel;
  },
  anthropic: ({ apiKey }) => {
    const baseUrl = process.env['ANTHROPIC_API_BASE'];
    return createAnthropic({
      // exactOptionalPropertyTypes: apiKey 为 undefined 时不传该字段
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(baseUrl !== undefined ? { baseURL: baseUrl } : {}),
    }) as unknown as (modelId: string) => LanguageModel;
  },
  ollama: () => {
    // 本地服务默认地址；OLLAMA_API_BASE 可覆盖（如远程 Ollama 服务器）
    // noPropertyAccessFromIndexSignature: process.env 必须用方括号访问
    const baseUrl = process.env['OLLAMA_API_BASE'] ?? 'http://localhost:11434';
    return createOpenAICompatible({
      name: 'ollama',
      baseURL: `${baseUrl}/v1`,
      apiKey: 'ollama',
      includeUsage: false,
    }) as unknown as (modelId: string) => LanguageModel;
  },
};

/**
 * Provider 注册表
 *
 * 无状态：所有供应商定义与工厂均为纯函数/常量。
 * 实例由 ServiceContainer 持有（经 ai-provider.ts 间接使用）。
 */
export class ProviderRegistry {
  private readonly providers: Map<ProviderKind, RegisteredProvider>;

  constructor(definitions: readonly ProviderDefinition[] = BUILTIN_DEFINITIONS) {
    this.providers = new Map();
    for (const definition of definitions) {
      const factory = BUILTIN_FACTORIES[definition.kind];
      if (factory === undefined) {
        throw new Error(`未注册供应商工厂：${definition.kind}`);
      }
      this.providers.set(definition.kind, { definition, factory });
    }
  }

  /**
   * 获取供应商定义
   *
   * @throws Error 未知供应商
   */
  getDefinition(kind: ProviderKind): ProviderDefinition {
    const entry = this.providers.get(kind);
    if (entry === undefined) {
      throw new Error(`未知模型供应商：${kind}`);
    }
    return entry.definition;
  }

  /**
   * 获取默认供应商（isDefault 标记的第一个）
   */
  getDefaultKind(): ProviderKind {
    for (const entry of this.providers.values()) {
      if (entry.definition.isDefault === true) {
        return entry.definition.kind;
      }
    }
    // 无 isDefault 标记时回落到第一个注册的供应商
    const [first] = this.providers.keys();
    if (first === undefined) {
      throw new Error('Provider 注册表为空，无法确定默认供应商');
    }
    return first;
  }

  /**
   * 创建 LanguageModel 工厂
   *
   * @param kind 供应商标识
   * @param context 创建上下文（apiKey / timeout）
   * @returns (modelId) => LanguageModel 工厂函数
   */
  createFactory(
    kind: ProviderKind,
    context: {
      readonly apiKey: string | undefined;
    },
  ): (modelId: string) => LanguageModel {
    const entry = this.providers.get(kind);
    if (entry === undefined) {
      throw new Error(`未知模型供应商：${kind}`);
    }
    return entry.factory(context);
  }

  /**
   * 列出所有已注册供应商（供 settings 域 / 设置 UI 展示）
   */
  list(): ProviderInfo[] {
    const defaultKind = this.getDefaultKind();
    const infos: ProviderInfo[] = [];
    for (const { definition } of this.providers.values()) {
      infos.push({
        kind: definition.kind,
        displayName: definition.displayName,
        defaultModel: definition.defaultModel,
        requiresApiKey: definition.requiresApiKey,
        isDefault: definition.kind === defaultKind,
      });
    }
    return infos;
  }
}
