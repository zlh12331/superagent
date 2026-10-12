import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb, resetDb } from './db';
import { deleteSetting, deleteSettings, readAllSettings, writeSetting } from './settings-pref';

const mocks = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/settings-pref-default'),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.mockGetPath,
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tempDir: string;

describe('settings-pref（app_settings 表，SQLite 单一真源）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'settings-pref-'));
    mocks.mockGetPath.mockReturnValue(tempDir);
    initDb();
  });

  afterEach(async () => {
    await closeDb();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('空表读取 → 空对象', () => {
    expect(readAllSettings()).toEqual({});
  });

  it('写入 + 读取往返（JSON 结构保真）', () => {
    writeSetting('theme', 'light');
    writeSetting('ai', { temperature: 0.9, defaultProvider: 'deepseek' });
    const settings = readAllSettings();
    expect(settings['theme']).toBe('light');
    expect(settings['ai']).toEqual({ temperature: 0.9, defaultProvider: 'deepseek' });
  });

  it('同 key 覆盖（upsert 不产生重复行）', () => {
    writeSetting('theme', 'dark');
    writeSetting('theme', 'light');
    const settings = readAllSettings();
    expect(settings['theme']).toBe('light');
    expect(Object.keys(settings)).toEqual(['theme']);
  });

  it('deleteSetting 删除后读取为空（幂等）', () => {
    writeSetting('theme', 'dark');
    deleteSetting('theme');
    expect(readAllSettings()).toEqual({});
    expect(() => deleteSetting('theme')).not.toThrow();
  });

  it('deleteSettings 批量删除（单事务；白名单外键不受影响；幂等）', () => {
    writeSetting('theme', 'dark');
    writeSetting('ai', { temperature: 1 });
    writeSetting('internal.trusted', { x: 1 });
    deleteSettings(['theme', 'ai', 'nonexistent']);
    expect(readAllSettings()).toEqual({ 'internal.trusted': { x: 1 } });
    expect(() => deleteSettings(['theme', 'ai', 'nonexistent'])).not.toThrow();
  });

  it('deleteSettings：非法 key 抛错（与单键删除同一防御）', () => {
    expect(() => deleteSettings(['a b'])).toThrow();
  });

  it('非法 key 抛错（防御：路径注入/超长 key）', () => {
    expect(() => writeSetting('a b', 'x')).toThrow();
    expect(() => writeSetting("'; DROP TABLE app_settings;--", 'x')).toThrow();
  });
});
