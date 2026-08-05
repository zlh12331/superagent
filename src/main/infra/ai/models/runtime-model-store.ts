// src/main/infra/ai/models/runtime-model-store.ts
// 运行时模型存储：用户手动配置模型的持久化 + 注册
// ──────────────────────────────────────────────────────────────
// 职责：
// - runtime_models 表持久化（元数据：modelId / providerKind / baseUrl）
// - apiKey 存 keychain（key = `runtime:${modelId}`，不落库）
// - 启动时加载并注册到 ModelRegistry（运行时快照与内置模型统一解析）
//
// 设计：
// - 对应 ModelRegistry 的 RuntimeModelSnapshot（AI 域模型注册表）
// - add 后需调用方 invalidateModel（缓存失效，下次 getModel 重建）
// - keychain key 约定与 keychain 域一致（`${前缀}-api-key` 风格：`runtime:${modelId}`）
// ──────────────────────────────────────────────────────────────

import { eq } from 'drizzle-orm';
import { logger } from '../../../utils/logger';
import { getDb } from '../../storage/db';
import { deleteSecret, setSecret } from '../../storage/keychain';
import { runtimeModels } from '../../storage/schema';
import type { ProviderKind } from '../providers/types';
import { modelRegistry } from './index';
import type { RuntimeModelSnapshot } from './types';
import { buildRuntimeSnapshotId } from './types';

/** keychain key 约定：runtime:${modelId}（API Key 不落库） */
export function runtimeModelKeychainKey(modelId: string): string {
  return `runtime:${modelId}`;
}

/**
 * 新增运行时模型的入参
 */
export interface AddRuntimeModelInput {
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  /** 显式 baseUrl（覆盖供应商默认端点；省略 = 默认） */
  readonly baseUrl?: string;
  /** 显式 API Key（省略 = 走 keychain 默认 key） */
  readonly apiKey?: string;
}

/**
 * 运行时模型存储
 *
 * 单例模式：由 ai-provider 层持有（与 modelRegistry 生命周期一致）。
 */
export class RuntimeModelStore {
  /**
   * 列出全部运行时模型（设置页展示）
   */
  async list(): Promise<RuntimeModelSnapshot[]> {
    const db = getDb();
    const rows = db.select().from(runtimeModels).orderBy(runtimeModels.createdAt).all();
    return rows.map((row) => ({
      id: buildRuntimeSnapshotId(row.providerKind as ProviderKind, row.modelId),
      providerKind: row.providerKind as ProviderKind,
      modelId: row.modelId,
      ...(row.baseUrl !== null ? { baseUrl: row.baseUrl } : {}),
      createdAt: row.createdAt,
    }));
  }

  /**
   * 新增运行时模型：DB 持久化 + keychain 存 key + 注册到 ModelRegistry
   *
   * 调用方需随后 llmClient.invalidateModel(modelId)（若已缓存）。
   */
  async add(input: AddRuntimeModelInput): Promise<void> {
    const db = getDb();
    db.insert(runtimeModels)
      .values({
        modelId: input.modelId,
        providerKind: input.providerKind,
        // exactOptionalPropertyTypes：可空列 undefined 时条件展开
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    if (input.apiKey !== undefined) {
      await setSecret(runtimeModelKeychainKey(input.modelId), input.apiKey);
    }
    // 注册到模型注册表（与内置模型统一解析）
    modelRegistry.registerRuntimeModel({
      id: buildRuntimeSnapshotId(input.providerKind, input.modelId),
      providerKind: input.providerKind,
      modelId: input.modelId,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      createdAt: Date.now(),
    });
  }

  /**
   * 删除运行时模型：DB 删除 + keychain 清 key + 注销注册
   */
  async remove(modelId: string): Promise<void> {
    // 先收集快照 id（DB 删除后 list 不再包含该模型）
    const snapshotIds = (await this.list()).filter((s) => s.modelId === modelId).map((s) => s.id);
    const db = getDb();
    db.delete(runtimeModels).where(eq(runtimeModels.modelId, modelId)).run();
    await deleteSecret(runtimeModelKeychainKey(modelId));
    for (const snapshotId of snapshotIds) {
      modelRegistry.unregisterRuntimeModel(snapshotId);
    }
  }

  /**
   * 启动时加载：DB 全部运行时模型注册到 ModelRegistry
   *
   * 由 ServiceContainer init 阶段调用（在 LLM 首次调用前）。
   */
  async loadAll(): Promise<void> {
    const snapshots = await this.list();
    for (const snapshot of snapshots) {
      modelRegistry.registerRuntimeModel(snapshot);
      logger.debug({ modelId: snapshot.modelId }, '运行时模型已加载');
    }
  }
}
