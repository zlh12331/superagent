// src/renderer/lib/__tests__/settings-bootstrap.test.ts
// settings-bootstrap 单测（S1：SQLite 快照 / legacy 迁移 / 浏览器回退）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapSettings } from '../settings-bootstrap';
import { SETTINGS_STORAGE_KEY } from '../theme-init';

describe('bootstrapSettings', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('Electron：SQLite 有数据 → 返回主进程快照（不经 localStorage）', async () => {
    window.api.settings = {
      getAll: vi.fn(async () => ({
        data: { settings: { theme: 'light', ai: { temperature: 0.8 } } },
      })),
      set: vi.fn(),
    } as never;
    const { theme, snapshot } = await bootstrapSettings();
    expect(theme).toBe('light');
    expect(snapshot['ai']).toEqual({ temperature: 0.8 });
  });

  it('Electron：SQLite 空 + legacy localStorage → 一次性迁移并清理', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        state: {
          theme: 'dark',
          shortcuts: { commandPalette: 'Meta+P', saveFile: 'Meta+S' },
        },
        version: 2,
      }),
    );
    const setMock = vi.fn(async () => ({ data: { ok: true } }));
    window.api.settings = {
      getAll: vi.fn(async () => ({ data: { settings: {} } })),
      set: setMock,
    } as never;
    const { theme } = await bootstrapSettings();
    expect(theme).toBe('dark');
    // 迁移写入（shortcuts 经 v3 归一化后落库）
    expect(setMock).toHaveBeenCalled();
    // legacy 清理
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
  });

  it('window.api 未注入（浏览器模式）→ legacy localStorage 回退', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { theme: 'system' }, version: 3 }),
    );
    Object.defineProperty(window, 'api', { value: undefined, configurable: true });
    const { theme } = await bootstrapSettings();
    expect(theme).toBe('system');
  });

  it('IPC 失败 → legacy 回退不抛', async () => {
    localStorage.setItem(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ state: { theme: 'light' }, version: 3 }),
    );
    window.api.settings = {
      getAll: vi.fn(async () => ({ error: { code: 'DB_ERROR', message: 'boom' } })),
    } as never;
    const { theme } = await bootstrapSettings();
    expect(theme).toBe('light');
  });
});
