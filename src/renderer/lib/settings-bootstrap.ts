import { SETTING_KEYS, type SettingKey } from '@code-agent/shared/renderer';
import { unwrap } from '@/lib/ipc';
import { SETTINGS_STORAGE_KEY } from '@/lib/theme-init';
import { migrateShortcuts, type Theme } from '@/stores/persistent/settings-store';

/** 旧版 localStorage 持久化结构（zustand persist 的 { state, version } 形状） */
interface LegacyPersisted {
  readonly state?: Record<string, unknown>;
  readonly version?: number;
}

/** 读取旧版 localStorage 设置（无/损坏 → null） */
function readLegacySettings(): LegacyPersisted | null {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) {
      return null;
    }
    const parsed = JSON.parse(raw) as LegacyPersisted;
    return typeof parsed.state === 'object' && parsed.state !== null ? parsed : null;
  } catch {
    return null;
  }
}

/** 把旧设置逐 key 写入主进程（迁移）；全部成功返回 true（P2：调用方据此决定是否清 legacy） */
async function migrateToMain(settings: Readonly<Record<string, unknown>>): Promise<boolean> {
  const api = window.api;
  if (api === undefined || api.settings === undefined) {
    return false;
  }
  const whitelist = new Set<string>(SETTING_KEYS);
  const entries = Object.entries(settings).filter((entry): entry is [SettingKey, unknown] =>
    whitelist.has(entry[0]),
  );
  const results = await Promise.allSettled(
    entries.map(([key, value]) => api.settings.set({ key, value })),
  );
  return results.every((r) => r.status === 'fulfilled');
}

/**
 * 启动引导：返回 { theme, snapshot }
 *
 * @returns theme 首帧主题（FOUC 防护）；snapshot 设置快照（applySettingsSnapshot 用）
 */
export async function bootstrapSettings(): Promise<{
  readonly theme: Theme;
  readonly snapshot: Record<string, unknown>;
}> {
  const legacy = readLegacySettings();
  const api = window.api;

  if (api !== undefined && api.settings !== undefined) {
    try {
      const data = unwrap(await api.settings.getAll({}));
      const settings = data.settings as Record<string, unknown>;
      if (Object.keys(settings).length > 0) {
        const migrated = migrateShortcuts(settings);
        return {
          theme: (migrated['theme'] as Theme | undefined) ?? 'dark',
          snapshot: migrated,
        };
      }
      if (legacy?.state !== undefined) {
        const migrated = migrateShortcuts(legacy.state);
        const allWritten = await migrateToMain(migrated);
        if (allWritten) {
          localStorage.removeItem(SETTINGS_STORAGE_KEY);
        }
        return {
          theme: (migrated['theme'] as Theme | undefined) ?? 'dark',
          snapshot: migrated,
        };
      }
      return { theme: 'dark', snapshot: {} };
    } catch {}
  }

  if (legacy?.state !== undefined) {
    const migrated = migrateShortcuts(legacy.state);
    return {
      theme: (migrated['theme'] as Theme | undefined) ?? 'dark',
      snapshot: migrated,
    };
  }
  return { theme: 'dark', snapshot: {} };
}
