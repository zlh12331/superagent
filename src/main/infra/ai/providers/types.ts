import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';

// types.ts：供应商契约——kind 枚举（与 config baseURL 表一一对应）、定义/工厂/注册项类型
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
  'mimo',
] as const;

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** 供应商静态定义（设置面表单依据） */
export interface ProviderDefinition {
  readonly kind: ProviderKind;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly isDefault?: boolean;
}

/** 工厂入参（apiKey 必带；baseUrl/apiFormat 运行时模型可覆盖） */
export interface ProviderCreateContext {
  readonly apiKey: string | undefined;
  readonly baseUrl?: string;
  readonly apiFormat?: ModelApiFormat;
}

export type ProviderFactory = (
  context: ProviderCreateContext,
) => (modelId: string) => LanguageModel;

export interface RegisteredProvider {
  readonly definition: ProviderDefinition;
  readonly factory: ProviderFactory;
}

export interface ProviderInfo {
  readonly kind: ProviderKind;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly isDefault: boolean;
}
