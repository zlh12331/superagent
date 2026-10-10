import {
  AppError,
  ErrorCode,
  MODEL_API_FORMATS,
  type ModelApiFormat,
} from '@code-agent/shared/main';
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

/** 运行时模型记录（DB 行视图，设置页列表展示用） */
export interface RuntimeModelRecord {
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  /** 显式 baseUrl（覆盖供应商默认端点；省略 = 默认） */
  readonly baseUrl?: string;
  /** 展示名称（自定义模式选填；省略 = 回退 modelId） */
  readonly displayName?: string;
  /** 单回合总时长上限（毫秒；省略 = 不限制，仅流空闲超时兜底） */
  readonly timeoutMs?: number;
  /** API 协议格式（省略 = openai-chat；仅自定义模式写非默认值） */
  readonly apiFormat?: ModelApiFormat;
  /** 启停状态（停用模型不注册、不可路由） */
  readonly isEnabled: boolean;
  readonly createdAt: number;
}

/** 新增运行时模型的入参 */
export interface AddRuntimeModelInput {
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  /** 显式 baseUrl（覆盖供应商默认端点；省略 = 默认） */
  readonly baseUrl?: string;
  /** 显式 API Key（省略 = 走 keychain 默认 key） */
  readonly apiKey?: string;
  /** 展示名称（省略 = 回退 modelId） */
  readonly displayName?: string;
  /** 单回合总时长上限（毫秒；省略 = 不限制） */
  readonly timeoutMs?: number;
  /** API 协议格式（省略 = openai-chat，与存量行为一致） */
  readonly apiFormat?: ModelApiFormat;
  /** 启停状态（省略 = 启用） */
  readonly isEnabled?: boolean;
}

/** 更新运行时模型的入参（partial 语义：省略字段不修改） */
export interface UpdateRuntimeModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  /** 传入时更新 keychain；省略 = 不修改 */
  readonly apiKey?: string;
  /**
   * 单回合总时长上限（毫秒；三态：省略 = 不修改，null = 清除（回不限制），
   * number = 设置）
   */
  readonly timeoutMs?: number | null;
  /** API 协议格式（省略 = 不修改） */
  readonly apiFormat?: ModelApiFormat;
  readonly isEnabled?: boolean;
}

/** DB 行 → 记录视图 */
function rowToRecord(row: {
  readonly modelId: string;
  readonly providerKind: string;
  readonly baseUrl: string | null;
  readonly displayName: string | null;
  readonly timeoutMs: number | null;
  readonly apiFormat: string | null;
  readonly isEnabled: number;
  readonly createdAt: number;
}): RuntimeModelRecord {
  return {
    modelId: row.modelId,
    providerKind: row.providerKind as ProviderKind,
    ...(row.baseUrl !== null ? { baseUrl: row.baseUrl } : {}),
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    ...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
    ...(isModelApiFormat(row.apiFormat) ? { apiFormat: row.apiFormat } : {}),
    isEnabled: row.isEnabled === 1,
    createdAt: row.createdAt,
  };
}

/** 单边校验：字符串是否为合法 API 格式（DB 脏值防御，免 zod 依赖） */
function isModelApiFormat(value: string | null): value is ModelApiFormat {
  return value !== null && (MODEL_API_FORMATS as readonly string[]).includes(value);
}

/** 记录 → 注册表快照（apiKey 存 keychain 不落库，不进快照） */
function toSnapshot(record: RuntimeModelRecord): RuntimeModelSnapshot {
  return {
    id: buildRuntimeSnapshotId(record.providerKind, record.modelId),
    providerKind: record.providerKind,
    modelId: record.modelId,
    ...(record.baseUrl !== undefined ? { baseUrl: record.baseUrl } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.apiFormat !== undefined ? { apiFormat: record.apiFormat } : {}),
    createdAt: record.createdAt,
  };
}

/**
 * 运行时模型存储
 *
 * 单例模式：由 ai-provider 层持有（与 modelRegistry 生命周期一致）。
 */
export class RuntimeModelStore {
  /**
   * 列出全部运行时模型（设置页列表展示）
   */
  async list(): Promise<RuntimeModelRecord[]> {
    const db = getDb();
    const rows = db.select().from(runtimeModels).orderBy(runtimeModels.createdAt).all();
    return rows.map(rowToRecord);
  }

  /**
   * 按 modelId 查询单条记录（不存在返回 undefined）
   */
  async get(modelId: string): Promise<RuntimeModelRecord | undefined> {
    const db = getDb();
    const row = db.select().from(runtimeModels).where(eq(runtimeModels.modelId, modelId)).get();
    return row === undefined ? undefined : rowToRecord(row);
  }

  /**
   * 新增运行时模型：DB 持久化 + keychain 存 key + 注册到 ModelRegistry
   *
   * 注册表同步在本方法内完成；LlmClient 的 per-model 缓存失效由调用方
   * settings.handler 在 add 后调用（见其 addRuntimeModel）。
   */
  async add(input: AddRuntimeModelInput): Promise<void> {
    const db = getDb();
    db.insert(runtimeModels)
      .values({
        modelId: input.modelId,
        providerKind: input.providerKind,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled ? 1 : 0 } : {}),
        createdAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
    if (input.apiKey !== undefined) {
      await setSecret(runtimeModelKeychainKey(input.modelId), input.apiKey);
    }
    if (input.isEnabled === false) {
      modelRegistry.registerDisabledModel(input.modelId);
      return;
    }
    modelRegistry.registerRuntimeModel({
      id: buildRuntimeSnapshotId(input.providerKind, input.modelId),
      providerKind: input.providerKind,
      modelId: input.modelId,
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      createdAt: Date.now(),
    });
  }

  /**
   * 更新运行时模型（partial：省略字段不修改）
   *
   * - displayName / baseUrl / isEnabled 落库
   * - apiKey 传入时更新 keychain（不落库）
   * - 注册表同步：注销旧快照后按最新记录重建；停用则仅注销
   * - LlmClient per-model 缓存失效由调用方 settings.handler 在 update 后调用
   *   （见其 updateRuntimeModel）
   *
   * @throws AppError(NOT_FOUND) modelId 不存在
   */
  async update(input: UpdateRuntimeModelInput): Promise<void> {
    const db = getDb();
    const existing = db
      .select()
      .from(runtimeModels)
      .where(eq(runtimeModels.modelId, input.modelId))
      .get();
    if (existing === undefined) {
      throw new AppError(ErrorCode.NOT_FOUND, undefined, undefined, { modelId: input.modelId });
    }
    const dbSet: {
      displayName?: string;
      baseUrl?: string;
      timeoutMs?: number | null;
      apiFormat?: ModelApiFormat;
      isEnabled?: 0 | 1;
    } = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
      ...(input.isEnabled !== undefined
        ? { isEnabled: input.isEnabled ? (1 as const) : (0 as const) }
        : {}),
    };
    if (Object.keys(dbSet).length > 0) {
      db.update(runtimeModels).set(dbSet).where(eq(runtimeModels.modelId, input.modelId)).run();
    }
    if (input.apiKey !== undefined) {
      await setSecret(runtimeModelKeychainKey(input.modelId), input.apiKey);
    }
    const snapshotId = buildRuntimeSnapshotId(existing.providerKind as ProviderKind, input.modelId);
    modelRegistry.unregisterRuntimeModel(snapshotId);
    modelRegistry.unregisterDisabledModel(input.modelId);
    const updated = await this.get(input.modelId);
    if (updated?.isEnabled) {
      modelRegistry.registerRuntimeModel(toSnapshot(updated));
    } else {
      modelRegistry.registerDisabledModel(input.modelId);
    }
  }

  /**
   * 删除运行时模型：DB 删除 + keychain 清 key + 注销注册
   */
  async remove(modelId: string): Promise<void> {
    const existing = await this.get(modelId);
    const db = getDb();
    db.delete(runtimeModels).where(eq(runtimeModels.modelId, modelId)).run();
    await deleteSecret(runtimeModelKeychainKey(modelId));
    modelRegistry.unregisterDisabledModel(modelId);
    if (existing !== undefined) {
      modelRegistry.unregisterRuntimeModel(buildRuntimeSnapshotId(existing.providerKind, modelId));
    }
  }

  /**
   * 启动时加载：DB 全部运行时模型同步到 ModelRegistry
   * - 启用中 → 注册快照（可路由）
   * - 停用 → 登记停用身份（resolve 拦截，重启后关闭仍生效）
   *
   * 由 ServiceContainer init 阶段调用（在 LLM 首次调用前）。
   */
  async loadAll(): Promise<void> {
    const records = await this.list();
    for (const record of records) {
      if (!record.isEnabled) {
        modelRegistry.registerDisabledModel(record.modelId);
        continue;
      }
      modelRegistry.registerRuntimeModel(toSnapshot(record));
      logger.debug({ modelId: record.modelId }, '运行时模型已加载');
    }
  }
}
