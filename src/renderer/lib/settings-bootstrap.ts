// src/renderer/lib/settings-bootstrap.ts
// 设置启动引导（S1：localStorage → SQLite 单一真源迁移 + 快照加载）
// ──────────────────────────────────────────────────────────────
// 流程（main.tsx 顶层 await，render 前完成，无主题闪烁）：
// 1. Electron：settings:getAll 拉 SQLite 快照
// 2. SQLite 为空且 localStorage 有旧值 → 一次性迁移（写库 + 清理 localStorage）
// 3. IPC 失败 / 浏览器模式 → 回退 localStorage 旧值
// 4. 快照经 migrateShortcuts 应用 v3 快捷键归一化迁移
// ──────────────────────────────────────────────────────────────

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
  const results = await Promise.allSettled(
    Object.entries(settings).map(([key, value]) => api.settings.set({ key, value })),
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
      // SQLite 为空：迁移 legacy localStorage（一次性）
      if (legacy?.state !== undefined) {
        const migrated = migrateShortcuts(legacy.state);
        // P2 修复（原子性）：全部写库成功才清 legacy——原实现 fire-and-forget
        // 写库后同步删 localStorage，任一 set 失败或进程在落库前退出，
        // 设置既不在 SQLite 也无副本，永久丢失回落默认值
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
    } catch {
      // IPC 失败 / 错误响应：回退 legacy（不阻断启动）
    }
  }

  // 浏览器模式 / IPC 失败回退：legacy localStorage
  if (legacy?.state !== undefined) {
    const migrated = migrateShortcuts(legacy.state);
    return {
      theme: (migrated['theme'] as Theme | undefined) ?? 'dark',
      snapshot: migrated,
    };
  }
  return { theme: 'dark', snapshot: {} };
}
