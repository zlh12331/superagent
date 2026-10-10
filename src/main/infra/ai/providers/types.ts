import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';

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

export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderDefinition {
  readonly kind: ProviderKind;
  readonly defaultModel: string;
  readonly requiresApiKey: boolean;
  readonly isDefault?: boolean;
}

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
