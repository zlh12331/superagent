// src/main/infra/ai/models/registry.ts
// 模型注册表：模型级解析 + 跨供应商查找 + 运行时快照
// ──────────────────────────────────────────────────────────────
// 职责：
// - 维护内置模型索引（模型 id → ModelEntry）
// - 按模型 id 解析：显式 id 优先；未传/未注册 → 供应商默认模型
// - 运行时快照注册/注销（手动配置的模型与内置模型统一解析）
// - 列出全部可用模型（设置 UI 下拉）
//
// 设计（对标 qwen-code modelRegistry + resolveModelAcrossAuthTypes）：
// - 模型是路由最小单元：resolve('gpt-4o-mini') 无需调用方知道供应商
// - 未知模型 id 不抛错：回退默认供应商默认模型并保留原始 id 透传
//   （兼容旧行为：调用方传任意 modelId 测试连接）
// - 本文件不依赖 SDK / config / keychain（纯领域层，便于单测）
// ──────────────────────────────────────────────────────────────

import type { ProviderKind } from '../providers/types';
import type { AvailableModelInfo, ModelEntry, ResolvedModel, RuntimeModelSnapshot } from './types';

/**
 * ModelRegistry 构造参数
 */
export interface ModelRegistryOptions {
  /** 内置模型条目表 */
  readonly entries: readonly ModelEntry[];
  /** 各供应商默认模型 id（未指定模型时解析目标） */
  readonly defaultModelByKind: Record<ProviderKind, string>;
  /** 全局默认供应商（未指定模型时的最终兜底） */
  readonly defaultKind: ProviderKind;
}

/**
 * 模型注册表
 *
 * 无状态（除运行时快照 Map 外）：内置模型为常量表。
 * 实例由 ai-provider 层持有（模块级单例）。
 */
export class ModelRegistry {
  private readonly modelIndex: Map<string, ModelEntry>;
  private readonly defaultModelByKind: Record<ProviderKind, string>;
  private readonly defaultKind: ProviderKind;
  /** 运行时快照：快照 id → 快照（用户手动配置的模型） */
  private readonly runtimeSnapshots = new Map<string, RuntimeModelSnapshot>();

  constructor(options: ModelRegistryOptions) {
    this.defaultModelByKind = options.defaultModelByKind;
    this.defaultKind = options.defaultKind;
    this.modelIndex = new Map();
    for (const entry of options.entries) {
      this.modelIndex.set(entry.id, entry);
    }
  }

  /**
   * 按模型 id 查找内置条目（不含运行时快照）
   */
  findBuiltin(modelId: string): ModelEntry | undefined {
    return this.modelIndex.get(modelId);
  }

  /**
   * 解析模型 id → 完整解析结果
   *
   * 优先级：
   * 1. modelId 显式提供且已注册（内置或运行时快照）→ 该模型条目
   * 2. modelId 显式提供但未注册 → 默认供应商默认模型 + 原始 id 透传
   *    （兼容旧行为：测试连接场景可传任意 modelId）
   * 3. modelId 未提供 → 默认供应商默认模型
   *
   * @param modelId 目标模型 id（省略 = 默认模型）
   * @returns 解析结果（永不抛错）
   */
  resolve(modelId: string | undefined): ResolvedModel {
    const explicit = modelId !== undefined ? this.resolveExplicit(modelId) : undefined;
    if (explicit !== undefined) {
      return explicit;
    }

    // 回退：默认供应商默认模型（原始 modelId 透传，兼容测试连接）
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
    };
  }

  /**
   * 注册运行时模型快照（幂等：同 id 覆盖）
   */
  registerRuntimeModel(snapshot: RuntimeModelSnapshot): void {
    this.runtimeSnapshots.set(snapshot.id, snapshot);
  }

  /**
   * 注销运行时模型快照（幂等）
   */
  unregisterRuntimeModel(snapshotId: string): void {
    this.runtimeSnapshots.delete(snapshotId);
  }

  /** 当前运行时快照数量（测试断言用） */
  getRuntimeSnapshotCount(): number {
    return this.runtimeSnapshots.size;
  }

  /**
   * 清空全部运行时快照（测试重置 / 应用级清理场景）
   */
  clearRuntimeModels(): void {
    this.runtimeSnapshots.clear();
  }

  /**
   * 列出全部可用模型（设置 UI 下拉）
   *
   * 内置模型 + 运行时快照模型。
   */
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

  /**
   * 解析显式模型 id（已注册的模型条目或运行时快照）
   */
  private resolveExplicit(modelId: string): ResolvedModel | undefined {
    // 1. 运行时快照优先（用户手动配置覆盖内置）
    const snapshot = this.findRuntimeSnapshot(modelId);
    if (snapshot !== undefined) {
      return {
        modelId: snapshot.modelId,
        providerKind: snapshot.providerKind,
        capabilities: {},
        generationConfig: undefined,
        isRuntime: true,
        explicitApiKey: snapshot.apiKey,
        explicitBaseUrl: snapshot.baseUrl,
      };
    }

    // 2. 内置模型条目
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
    };
  }

  /** 按模型 id 查找运行时快照（遍历快照值） */
  private findRuntimeSnapshot(modelId: string): RuntimeModelSnapshot | undefined {
    for (const snapshot of this.runtimeSnapshots.values()) {
      if (snapshot.modelId === modelId) {
        return snapshot;
      }
    }
    return undefined;
  }
}
