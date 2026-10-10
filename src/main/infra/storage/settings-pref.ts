// settings-pref.ts：用户设置持久化（SQLite app_settings 表）——key 白名单校验 + JSON 值存取
// 真源即本表：渲染层 settings-store 写穿透到这里；draft/sidebar 等纯 UI 态不走这里
import { eq, sql } from 'drizzle-orm';

import { getDb } from './db';
import { appSettings } from './schema';

// key 形态白名单：字母开头 + 字母数字点横下划线 ≤64——表键是用户可控字符串，防注入/垃圾键
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/** 读全部设置（值 JSON 反序列化；损坏条目静默剔除不炸启动快照） */
export function readAllSettings(): Record<string, unknown> {
  const rows = getDb().select().from(appSettings).all();
  const settings: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {}
  }
  return settings;
}

/** 读单个设置（缺失或值损坏返回 undefined——调用方走自己的默认值） */
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
    return undefined;
  }
}

// 单值 256KB 上限：设置表不承载大对象（会话正文有专门的表），超限直接拒写
const MAX_SETTING_VALUE_CHARS = 256 * 1024;

/** 写单个设置（upsert） */
export function writeSetting(key: string, value: unknown): void {
  assertKey(key);
  writeSettings([{ key, value }]);
}

/** 批量写（事务包裹：部分失败整体回滚，不出现半新半旧的设置集） */
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

/** 删除单个设置 */
export function deleteSetting(key: string): void {
  assertKey(key);
  getDb().delete(appSettings).where(eq(appSettings.key, key)).run();
}

/** 批量删除（白名单键集——settings:resetAll 用；事务保证原子） */
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

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`非法设置 key: ${key}`);
  }
}
