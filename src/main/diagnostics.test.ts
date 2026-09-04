// src/main/diagnostics.test.ts
// 诊断包导出单测：脱敏边界 + zip 组装（manifest/settings/logs 齐全性）
// ──────────────────────────────────────────────────────────────
// 测试策略（复用 settings-pref.test 的「真实 better-sqlite3 临时目录」基建）：
// - redactSensitive 纯函数：敏感键全形态验证（顶层/嵌套/数组）
// - exportDiagnosticsPackage：注入临时 userData（含真实 SQLite 库 + 日志），
//   验证 manifest.json / settings.json（脱敏落盘）/ logs/*.log 三件套齐全

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportDiagnosticsPackage, redactSensitive } from './diagnostics';
import { closeDb, initDb, resetDb } from './infra/storage/db';
import { writeSetting } from './infra/storage/settings-pref';

const mocks = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/diagnostics-default'),
}));

vi.mock('electron', () => ({
  app: {
    getName: () => 'code-agent-desktop',
    getVersion: () => '1.0.0',
    getPath: mocks.mockGetPath,
    // initDb 的 resolveMigrationsDir 需要：dev 环境指向项目根 drizzle/
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('./utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tempUserData: string;

/** 每个用例前重置临时 userData + 真实 SQLite（纯函数用例也容忍，保持类型收敛简单） */
function setupTempEnvironment(): void {
  tempUserData = mkdtempSync(join(tmpdir(), 'diag-'));
  mocks.mockGetPath.mockReturnValue(tempUserData);
  initDb();
  // 预置设置：普通项保留 + 敏感项必须脱敏
  writeSetting('theme', 'dark');
  writeSetting('model', 'deepseek-v4-flash');
  writeSetting('credentials', { apiKey: 'sk-super-secret', baseUrl: 'https://api.example.com' });
  writeSetting('tokens', ['t-1', 't-2']);
}

/** 环境初始化在 beforeEach 中执行（覆盖纯函数与打包两组用例） */
beforeEach(() => {
  setupTempEnvironment();
});

afterEach(async () => {
  await closeDb();
  resetDb();
  rmSync(tempUserData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('redactSensitive', () => {
  it('命中敏感键：值替换为 [REDACTED]', () => {
    expect(redactSensitive('sk-123456', 'apiKey')).toBe('[REDACTED]');
    expect(redactSensitive('abcd', 'provider.api_key')).toBe('[REDACTED]');
    expect(redactSensitive('abc', 'ACCESS_TOKEN')).toBe('[REDACTED]');
    expect(redactSensitive('secret', 'authPassword')).toBe('[REDACTED]');
  });

  it('普通键：原样透传', () => {
    expect(redactSensitive('deepseek', 'provider')).toBe('deepseek');
    expect(redactSensitive(42, 'theme.fontSize')).toBe(42);
    expect(redactSensitive(undefined, 'optional')).toBeUndefined();
    expect(redactSensitive(null, 'nullValue')).toBeNull();
  });

  it('嵌套对象：逐层脱敏且不修改原对象（纯函数）', () => {
    const input = {
      model: 'deepseek-v4-flash',
      credentials: { apiKey: 'sk-secret', baseUrl: 'https://api.example.com' },
    };
    const result = redactSensitive(input) as Record<string, unknown>;
    expect(result['model']).toBe('deepseek-v4-flash');
    expect((result['credentials'] as Record<string, unknown>)['apiKey']).toBe('[REDACTED]');
    expect((result['credentials'] as Record<string, unknown>)['baseUrl']).toBe(
      'https://api.example.com',
    );
    // 原对象不被污染
    expect((input.credentials as { apiKey: string }).apiKey).toBe('sk-secret');
  });

  it('数组：逐项脱敏', () => {
    const result = redactSensitive([{ token: 't1' }, { name: 'keep' }]) as unknown[];
    expect(result[0]).toEqual({ token: '[REDACTED]' });
    expect(result[1]).toEqual({ name: 'keep' });
  });
});

describe('exportDiagnosticsPackage', () => {
  it('打包：manifest/settings（脱敏）/logs 三件套齐全', async () => {
    // 构造日志目录（含轮转 old 文件）
    const logsDir = join(tempUserData, 'logs');
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, 'main.log'), '2026-09-04 info ready\n', 'utf8');
    writeFileSync(join(logsDir, 'main.old.log'), 'rotated\n', 'utf8');

    const target = join(mkdtempSync(join(tmpdir(), 'diag-out-')), 'pack.zip');

    await exportDiagnosticsPackage({ filePath: target, userDataPath: tempUserData });

    const zip = new AdmZip(target);
    const names = zip
      .getEntries()
      .map((entry) => entry.entryName)
      .sort();
    expect(names).toContain('manifest.json');
    expect(names).toContain('settings.json');
    expect(names).toContain('logs/main.log');
    expect(names).toContain('logs/main.old.log');

    // manifest：版本清单字段
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as Record<string, unknown>;
    expect(manifest['appVersion']).toBe('1.0.0');
    expect(manifest['exportedAt']).toBeTypeOf('string');
    expect((manifest['versions'] as Record<string, unknown>)['node']).toBeTypeOf('string');

    // settings：普通项保留、敏感项逐项脱敏
    const settings = JSON.parse(zip.readAsText('settings.json')) as Record<string, unknown>;
    expect(settings['theme']).toBe('dark');
    expect(settings['model']).toBe('deepseek-v4-flash');
    expect((settings['credentials'] as { apiKey: string }).apiKey).toBe('[REDACTED]');
    expect((settings['credentials'] as { baseUrl: string }).baseUrl).toBe(
      'https://api.example.com',
    );
    expect(settings['tokens']).toEqual(['[REDACTED]', '[REDACTED]']);
  });

  it('打包：日志目录缺失时降级为空日志段，不抛错', async () => {
    const target = join(mkdtempSync(join(tmpdir(), 'diag-out-')), 'pack.zip');

    await expect(
      exportDiagnosticsPackage({ filePath: target, userDataPath: tempUserData }),
    ).resolves.toBeUndefined();

    const zip = new AdmZip(target);
    const names = zip.getEntries().map((entry) => entry.entryName);
    expect(names).toContain('manifest.json');
    expect(names).toContain('settings.json');
  });
});
