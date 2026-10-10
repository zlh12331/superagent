import { eq, sql } from 'drizzle-orm';

import { getDb } from './db';
import { appSettings } from './schema';

const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

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

const MAX_SETTING_VALUE_CHARS = 256 * 1024;

export function writeSetting(key: string, value: unknown): void {
  assertKey(key);
  writeSettings([{ key, value }]);
}

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

export function deleteSetting(key: string): void {
  assertKey(key);
  getDb().delete(appSettings).where(eq(appSettings.key, key)).run();
}

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
