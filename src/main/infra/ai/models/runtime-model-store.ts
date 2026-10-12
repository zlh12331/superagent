// runtime-model-store.ts：用户自定义模型 CRUD（runtime_models 表）——apiKey 落 keychain，
// 变更同步 modelRegistry 快照与停用集
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

/** 运行时模型的 keychain 键（runtime:<modelId>） */
export function runtimeModelKeychainKey(modelId: string): string {
  return `runtime:${modelId}`;
}

/** 能力覆盖（高级配置手填项；字段省略 = 该项回退内置清单） */
export interface RuntimeCapabilitiesOverride {
  readonly contextWindowSize?: number;
  readonly maxOutputTokens?: number;
  readonly vision?: boolean;
}

/** 运行时模型记录（表行 + isEnabled 展开） */
export interface RuntimeModelRecord {
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  readonly baseUrl?: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  readonly apiFormat?: ModelApiFormat;
  readonly capabilitiesOverride?: RuntimeCapabilitiesOverride | undefined;
  readonly isEnabled: boolean;
  readonly createdAt: number;
}

export interface AddRuntimeModelInput {
  readonly modelId: string;
  readonly providerKind: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly displayName?: string;
  readonly timeoutMs?: number;
  readonly apiFormat?: ModelApiFormat;
  readonly capabilitiesOverride?: RuntimeCapabilitiesOverride | undefined;
  readonly isEnabled?: boolean;
}

export interface UpdateRuntimeModelInput {
  readonly modelId: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly timeoutMs?: number | null;
  readonly apiFormat?: ModelApiFormat;
  readonly capabilitiesOverride?: RuntimeCapabilitiesOverride | null | undefined;
  readonly isEnabled?: boolean;
}

/** row.capabilities JSON → 类型化覆盖（畸形 JSON 丢弃，不抛错） */
function parseCapabilitiesOverride(raw: unknown): RuntimeCapabilitiesOverride | undefined {
  if (typeof raw !== 'string') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof parsed['contextWindowSize'] === 'number') {
      out['contextWindowSize'] = parsed['contextWindowSize'];
    }
    if (typeof parsed['maxOutputTokens'] === 'number') {
      out['maxOutputTokens'] = parsed['maxOutputTokens'];
    }
    if (typeof parsed['vision'] === 'boolean') {
      out['vision'] = parsed['vision'];
    }
    return Object.keys(out).length > 0 ? (out as RuntimeCapabilitiesOverride) : undefined;
  } catch {
    return undefined;
  }
}

function rowToRecord(row: {
  readonly modelId: string;
  readonly providerKind: string;
  readonly baseUrl: string | null;
  readonly displayName: string | null;
  readonly timeoutMs: number | null;
  readonly apiFormat: string | null;
  readonly capabilities: unknown;
  readonly isEnabled: number;
  readonly createdAt: number;
}): RuntimeModelRecord {
  const capabilitiesOverride = parseCapabilitiesOverride(row.capabilities);
  return {
    modelId: row.modelId,
    providerKind: row.providerKind as ProviderKind,
    ...(row.baseUrl !== null ? { baseUrl: row.baseUrl } : {}),
    ...(row.displayName !== null ? { displayName: row.displayName } : {}),
    ...(row.timeoutMs !== null ? { timeoutMs: row.timeoutMs } : {}),
    ...(isModelApiFormat(row.apiFormat) ? { apiFormat: row.apiFormat } : {}),
    ...(capabilitiesOverride !== undefined ? { capabilitiesOverride } : {}),
    isEnabled: row.isEnabled === 1,
    createdAt: row.createdAt,
  };
}

function isModelApiFormat(value: string | null): value is ModelApiFormat {
  return value !== null && (MODEL_API_FORMATS as readonly string[]).includes(value);
}

function toSnapshot(record: RuntimeModelRecord): RuntimeModelSnapshot {
  return {
    id: buildRuntimeSnapshotId(record.providerKind, record.modelId),
    providerKind: record.providerKind,
    modelId: record.modelId,
    ...(record.baseUrl !== undefined ? { baseUrl: record.baseUrl } : {}),
    ...(record.timeoutMs !== undefined ? { timeoutMs: record.timeoutMs } : {}),
    ...(record.apiFormat !== undefined ? { apiFormat: record.apiFormat } : {}),
    ...(record.capabilitiesOverride !== undefined
      ? { capabilitiesOverride: record.capabilitiesOverride }
      : {}),
    createdAt: record.createdAt,
  };
}

export class RuntimeModelStore {
  async list(): Promise<RuntimeModelRecord[]> {
    const db = getDb();
    const rows = db.select().from(runtimeModels).orderBy(runtimeModels.createdAt).all();
    return rows.map(rowToRecord);
  }

  async get(modelId: string): Promise<RuntimeModelRecord | undefined> {
    const db = getDb();
    const row = db.select().from(runtimeModels).where(eq(runtimeModels.modelId, modelId)).get();
    return row === undefined ? undefined : rowToRecord(row);
  }

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
        ...(input.capabilitiesOverride !== undefined
          ? { capabilities: JSON.stringify(input.capabilitiesOverride) }
          : {}),
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
      ...(input.capabilitiesOverride !== undefined
        ? { capabilitiesOverride: input.capabilitiesOverride }
        : {}),
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      createdAt: Date.now(),
    });
  }

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
    // capabilities 三态：省略 = 不修改；null = 清除覆盖（JSON 置 null）；对象 = 写入
    const dbSet: {
      displayName?: string;
      baseUrl?: string;
      timeoutMs?: number | null;
      apiFormat?: ModelApiFormat;
      capabilities?: string | null;
      isEnabled?: 0 | 1;
    } = {
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
      ...(input.capabilitiesOverride === null
        ? { capabilities: null }
        : input.capabilitiesOverride !== undefined
          ? { capabilities: JSON.stringify(input.capabilitiesOverride) }
          : {}),
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
