// src/main/infra/storage/settings-pref.ts
// 渲染层用户设置持久化（app_settings 表，SQLite 单一真源）
// ──────────────────────────────────────────────────────────────
// S1 设计（settings 下沉 SQLite，用户决策）：
// - 此前 settings 只活在 renderer localStorage（清缓存即丢、主进程读不到）
// - 现收敛为 SQLite app_settings 表：key → JSON value
// - 渲染层 settings-store 保持内存态即时性，写穿透经 settings:set IPC 落库；
//   启动时经 settings:getAll 拉取快照（main.tsx 顶层 await，无主题闪烁）
// - 主进程不解析 value 结构（结构契约由渲染层 settings-store 定义）
// ──────────────────────────────────────────────────────────────

import { eq, sql } from 'drizzle-orm';

import { getDb } from './db';
import { appSettings } from './schema';

/** 设置域 key 校验（防御：仅允许字母开头 + 字母数字/点/下划线/连字符） */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/**
 * 同步读取全部设置（key → 已解析 JSON 值；单条损坏跳过不阻断整体）
 *
 * drizzle better-sqlite3 驱动为同步 API：启动时由 settings:getAll handler 调用。
 */
export function readAllSettings(): Record<string, unknown> {
  const rows = getDb().select().from(appSettings).all();
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      // 损坏条目：跳过（单条损坏不阻断整体读取）
    }
  }
  return settings;
}

/**
 * 同步读取单个设置（未设置返回 undefined；损坏值视为未设置）
 *
 * 用于高频读取场景（如 file:list 每次调用读忽略配置）：仅查单行，避免全表扫描。
 */
export function readSetting(key: string): unknown {
  assertKey(key);
  const rows = getDb().select().from(appSettings).where(eq(appSettings.key, key)).all();
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(row.value);
  } catch {
    // 损坏条目：视为未设置（调用方走默认值）
    return undefined;
  }
}

/** 单条设置值序列化后的字符数上限（256K chars；UTF-8 下 CJK 至多 3 字节/字符） */
const MAX_SETTING_VALUE_CHARS = 256 * 1024;

/**
 * 同步写入单个设置（upsert；value 为 JSON 可序列化结构）
 *
 * 渲染层写穿透：每次内存态变更后 fire-and-forget 调用。
 * P2 修复：value 无大小约束时，渲染层 bug 可把任意大 JSON 写入 app_settings，
 * 之后每次启动全表加载 parse（readAllSettings）——此处按序列化尺寸硬上限拒绝。
 */
export function writeSetting(key: string, value: unknown): void {
  assertKey(key);
  writeSettings([{ key, value }]);
}

/**
 * 批量写入设置（单事务原子提交）
 *
 * 设置导入（settings:import）使用：逐键过白名单后的写入走本方法——
 * 任一键值非法（超尺寸/不可序列化）→ 整批回滚，不产生"半截导入"。
 * 幂等：upsert 语义，重复导入同一文件结果一致。
 *
 * @throws Error key 非法（assertKey）或任一 value 序列化超限（事务整体回滚）
 */
export function writeSettings(entries: ReadonlyArray<{ key: string; value: unknown }>): void {
  if (entries.length === 0) {
    return;
  }
  for (const entry of entries) {
    assertKey(entry.key);
  }
  getDb().transaction((tx) => {
    for (const entry of entries) {
      const serialized = JSON.stringify(entry.value);
      if (serialized.length > MAX_SETTING_VALUE_CHARS) {
        throw new Error(
          `设置值过大（${serialized.length} > ${MAX_SETTING_VALUE_CHARS} 字符）：${entry.key}`,
        );
      }
      tx.insert(appSettings)
        .values({ key: entry.key, value: serialized, updatedAt: Date.now() })
        .onConflictDoUpdate({
          target: appSettings.key,
          set: { value: sql`excluded.value`, updatedAt: sql`excluded.updated_at` },
        })
        .run();
    }
  });
}

/** 删除单个设置（当前无消费方，预留 API；幂等） */
export function deleteSetting(key: string): void {
  assertKey(key);
  getDb().delete(appSettings).where(eq(appSettings.key, key)).run();
}

/**
 * 批量删除设置（单事务原子提交）
 *
 * 恢复默认设置（settings:resetAll）使用：按 SETTING_KEYS 白名单传入键清单，
 * 白名单外的键（如未来新增的主进程内部配置组）不受影响。幂等：删除不存在的
 * 键无副作用。键缺失即默认——主进程各 readSetting 消费方均有 undefined→默认
 * 兜底（readCloseAction/isAutoCheckEnabled 等，见各自注释）。
 */
export function deleteSettings(keys: ReadonlyArray<string>): void {
  if (keys.length === 0) {
    return;
  }
  for (const key of keys) {
    assertKey(key);
  }
  getDb().transaction((tx) => {
    for (const key of keys) {
      tx.delete(appSettings).where(eq(appSettings.key, key)).run();
    }
  });
}

/** key 合法性校验 */
function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`非法设置 key: ${key}`);
  }
}
