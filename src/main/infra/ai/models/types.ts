import type { ModelApiFormat } from '@code-agent/shared/main';

import type { ProviderKind } from '../providers/types';
import type { ReasoningEffort } from './reasoning-effort';

export type { ReasoningEffort };

export interface ModelCapabilities {
  vision?: boolean;
  contextWindowSize?: number;
  maxOutputTokens?: number;
  fastOnly?: boolean;
  reasoning?: boolean;
}

export interface ModelGenerationConfig {
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoningEffort?: ReasoningEffort;
  maxRetries?: number;
  timeoutMs?: number;
  extra?: Record<string, unknown>;
}

export interface ModelEntry {
  readonly id: string;
  readonly providerKind: ProviderKind;
  readonly displayName?: string;
  readonly capabilities?: ModelCapabilities;
  readonly generationConfig?: ModelGenerationConfig;
}

export interface RuntimeModelSnapshot {
  readonly id: string;
  readonly providerKind: ProviderKind;
  readonly modelId: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly apiFormat?: ModelApiFormat;
  readonly timeoutMs?: number;
  readonly createdAt: number;
}

export interface ResolvedModel {
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  readonly capabilities: ModelCapabilities;
  readonly generationConfig: ModelGenerationConfig | undefined;
  readonly isRuntime: boolean;
  readonly explicitApiKey: string | undefined;
  readonly explicitBaseUrl: string | undefined;
  readonly apiFormat: ModelApiFormat | undefined;
  readonly available: boolean;
}

export interface AvailableModelInfo {
  readonly id: string;
  readonly label: string;
  readonly providerKind: ProviderKind;
  readonly isRuntime: boolean;
  readonly capabilities: ModelCapabilities;
}

export const RUNTIME_SNAPSHOT_PREFIX = '$runtime|';

export function buildRuntimeSnapshotId(providerKind: ProviderKind, modelId: string): string {
  return `${RUNTIME_SNAPSHOT_PREFIX}${providerKind}|${modelId}`;
}
