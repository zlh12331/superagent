import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb, resetDb } from './db';
import { applySettingsImport, buildSettingsExportFile } from './settings-io';
import { readAllSettings, writeSetting } from './settings-pref';

const mocks = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/settings-io-default'),
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

describe('settings-io（app_settings 全表 ↔ 版本化 JSON）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'settings-io-'));
    mocks.mockGetPath.mockReturnValue(tempDir);
    initDb();
  });

  afterEach(async () => {
    await closeDb();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('导出：version=1 + exportedAt + settings 全表快照', () => {
    writeSetting('theme', 'dark');
    writeSetting('ai', { temperature: 0.9 });

    const file = buildSettingsExportFile();

    expect(file.version).toBe(1);
    expect(typeof file.exportedAt).toBe('number');
    expect(file.settings).toEqual(readAllSettings());
    expect(file.settings).toMatchObject({ theme: 'dark', ai: { temperature: 0.9 } });
  });

  it('导入正向：白名单键写入 + 白名单外键跳过计数，applied 供逐键广播', () => {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      settings: {
        theme: 'dark',
        ai: { temperature: 0.5 },
        'runtime.models': { evil: true },
        unknownDomain: 1,
      },
    };

    const outcome = applySettingsImport(payload);

    expect(outcome.imported).toBe(2);
    expect(outcome.skipped).toBe(2);
    expect(outcome.applied.map((a) => a.key)).toEqual(['theme', 'ai']);
    const settings = readAllSettings();
    expect(settings).toEqual({ theme: 'dark', ai: { temperature: 0.5 } });
  });

  it('安全：__proto__ 键不进入写入集合，原型不被污染', () => {
    const payload: unknown = JSON.parse(
      `{"version":1,"exportedAt":1,"settings":{"theme":"dark","__proto__":{"polluted":true}}}`,
    );

    const outcome = applySettingsImport(payload);

    expect(outcome.applied.map((a) => a.key)).toEqual(['theme']);
    const settings = readAllSettings();
    expect(Object.hasOwn(settings, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('覆盖语义：已有值被文件中的同名键覆盖（导入前 theme=light）', () => {
    writeSetting('theme', 'light');

    const outcome = applySettingsImport({
      version: 1,
      exportedAt: Date.now(),
      settings: { theme: 'dark' },
    });

    expect(outcome.imported).toBe(1);
    expect(readAllSettings()['theme']).toBe('dark');
  });

  it('幂等：同一文件重复导入 → 结果一致（upsert 不产生重复行）', () => {
    const payload = {
      version: 1,
      exportedAt: Date.now(),
      settings: { theme: 'dark', editor: { fontSize: 14 } },
    };

    const first = applySettingsImport(payload);
    const second = applySettingsImport(payload);

    expect(second).toEqual(first);
    expect(readAllSettings()).toEqual({ theme: 'dark', editor: { fontSize: 14 } });
  });

  it('校验：version 缺失 / 版本不匹配 / settings 非对象 → INVALID_INPUT，库零写入', () => {
    writeSetting('theme', 'light');

    for (const bad of [
      { exportedAt: 1, settings: {} },
      { version: 2, exportedAt: 1, settings: {} },
      { version: 1, exportedAt: 1, settings: 'not-object' },
      'not-an-object',
      null,
    ]) {
      expect(() => applySettingsImport(bad)).toThrowError(
        expect.objectContaining({ code: ErrorCode.INVALID_INPUT }),
      );
    }
    expect(readAllSettings()).toEqual({ theme: 'light' });
  });

  it('原子性：白名单内任一值超尺寸 → 整批回滚，合法键也不落库（不产生半截导入）', () => {
    writeSetting('theme', 'light');

    const oversized = 'x'.repeat(256 * 1024 + 1);
    expect(() =>
      applySettingsImport({
        version: 1,
        exportedAt: Date.now(),
        settings: { editor: { fontSize: 14 }, theme: oversized },
      }),
    ).toThrowError(/设置值过大/);

    expect(readAllSettings()).toEqual({ theme: 'light' });
  });
});
