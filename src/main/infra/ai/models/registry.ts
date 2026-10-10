import type { ProviderKind } from '../providers/types';
import type {
  AvailableModelInfo,
  ModelEntry,
  ModelGenerationConfig,
  ResolvedModel,
  RuntimeModelSnapshot,
} from './types';

function mergeSnapshotGenerationConfig(
  builtin: ModelGenerationConfig | undefined,
  snapshot: RuntimeModelSnapshot,
): ModelGenerationConfig | undefined {
  if (snapshot.timeoutMs === undefined) {
    return builtin;
  }
  return { ...builtin, timeoutMs: snapshot.timeoutMs };
}

export interface ModelRegistryOptions {
  readonly entries: readonly ModelEntry[];
  readonly defaultModelByKind: Record<ProviderKind, string>;
  readonly defaultKind: ProviderKind;
}

export class ModelRegistry {
  private readonly modelIndex: Map<string, ModelEntry>;
  private readonly defaultModelByKind: Record<ProviderKind, string>;
  private readonly defaultKind: ProviderKind;
  private readonly runtimeSnapshots = new Map<string, RuntimeModelSnapshot>();
  private readonly disabledModels = new Set<string>();

  constructor(options: ModelRegistryOptions) {
    this.defaultModelByKind = options.defaultModelByKind;
    this.defaultKind = options.defaultKind;
    this.modelIndex = new Map();
    for (const entry of options.entries) {
      this.modelIndex.set(entry.id, entry);
    }
  }

  findBuiltin(modelId: string): ModelEntry | undefined {
    return this.modelIndex.get(modelId);
  }

  registerDisabledModel(modelId: string): void {
    this.disabledModels.add(modelId);
  }

  unregisterDisabledModel(modelId: string): void {
    this.disabledModels.delete(modelId);
  }

  isModelDisabled(modelId: string): boolean {
    return this.disabledModels.has(modelId);
  }

  resolve(modelId: string | undefined): ResolvedModel {
    const target = modelId ?? this.defaultModelByKind[this.defaultKind];
    if (this.disabledModels.has(target)) {
      const entry = this.modelIndex.get(target);
      return {
        modelId: target,
        providerKind: entry?.providerKind ?? this.defaultKind,
        capabilities: entry?.capabilities ?? {},
        generationConfig: entry?.generationConfig,
        isRuntime: false,
        explicitApiKey: undefined,
        explicitBaseUrl: undefined,
        apiFormat: undefined,
        available: false,
      };
    }

    const explicit = modelId !== undefined ? this.resolveExplicit(modelId) : undefined;
    if (explicit !== undefined) {
      return explicit;
    }

    const defaultModelId = this.defaultModelByKind[this.defaultKind];
    const entry = this.modelIndex.get(defaultModelId);
    return {
      modelId: modelId ?? defaultModelId,
      providerKind: this.defaultKind,
      capabilities: entry?.capabilities ?? {},
      generationConfig: entry?.generationConfig,
      isRuntime: false,
      explicitApiKey: undefined,
      explicitBaseUrl: undefined,
      apiFormat: undefined,
      available: true,
    };
  }

  registerRuntimeModel(snapshot: RuntimeModelSnapshot): void {
    this.runtimeSnapshots.set(snapshot.id, snapshot);
  }

  unregisterRuntimeModel(snapshotId: string): void {
    this.runtimeSnapshots.delete(snapshotId);
  }

  getRuntimeSnapshotCount(): number {
    return this.runtimeSnapshots.size;
  }

  clearRuntimeModels(): void {
    this.runtimeSnapshots.clear();
  }

  listModels(): AvailableModelInfo[] {
    const builtins: AvailableModelInfo[] = [];
    for (const entry of this.modelIndex.values()) {
      builtins.push({
        id: entry.id,
        label: entry.displayName ?? entry.id,
        providerKind: entry.providerKind,
        isRuntime: false,
        capabilities: entry.capabilities ?? {},
      });
    }
    const runtimes: AvailableModelInfo[] = [];
    for (const snapshot of this.runtimeSnapshots.values()) {
      runtimes.push({
        id: snapshot.modelId,
        label: snapshot.modelId,
        providerKind: snapshot.providerKind,
        isRuntime: true,
        capabilities: {},
      });
    }
    return [...builtins, ...runtimes];
  }

  private resolveExplicit(modelId: string): ResolvedModel | undefined {
    const snapshot = this.findRuntimeSnapshot(modelId);
    if (snapshot !== undefined) {
      const builtin = this.modelIndex.get(snapshot.modelId);
      return {
        modelId: snapshot.modelId,
        providerKind: snapshot.providerKind,
        capabilities: builtin?.capabilities ?? {},
        generationConfig: mergeSnapshotGenerationConfig(builtin?.generationConfig, snapshot),
        isRuntime: true,
        explicitApiKey: snapshot.apiKey,
        explicitBaseUrl: snapshot.baseUrl,
        apiFormat: snapshot.apiFormat,
        available: true,
      };
    }

    const entry = this.modelIndex.get(modelId);
    if (entry === undefined) {
      return undefined;
    }
    return {
      modelId: entry.id,
      providerKind: entry.providerKind,
      capabilities: entry.capabilities ?? {},
      generationConfig: entry.generationConfig,
      isRuntime: false,
      explicitApiKey: undefined,
      explicitBaseUrl: undefined,
      apiFormat: undefined,
      available: true,
    };
  }

  private findRuntimeSnapshot(modelId: string): RuntimeModelSnapshot | undefined {
    for (const snapshot of this.runtimeSnapshots.values()) {
      if (snapshot.modelId === modelId) {
        return snapshot;
      }
    }
    return undefined;
  }
}
