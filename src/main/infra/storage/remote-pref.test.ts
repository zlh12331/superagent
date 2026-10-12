import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, initDb, resetDb } from './db';
import { readRemoteBindScope, resolveBindAddress, writeRemoteBindScope } from './remote-pref';
import { readSetting, writeSetting } from './settings-pref';

const mocks = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/remote-pref-default'),
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

describe('remote-pref（remote.bindScope，app_settings 表）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'remote-pref-'));
    mocks.mockGetPath.mockReturnValue(tempDir);
    initDb();
  });

  afterEach(async () => {
    await closeDb();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('未设置 → 默认 lan（兼容存量局域网直连行为）', () => {
    expect(readRemoteBindScope()).toBe('lan');
  });

  it('写入 + 读取往返（lan / loopback 两态）', () => {
    writeRemoteBindScope('loopback');
    expect(readRemoteBindScope()).toBe('loopback');
    expect(readSetting('remote.bindScope')).toBe('loopback');
    writeRemoteBindScope('lan');
    expect(readRemoteBindScope()).toBe('lan');
  });

  it('存储值非法（类型不符/枚举外）→ 回退默认 lan，不抛错', () => {
    writeSetting('remote.bindScope', '0.0.0.0');
    expect(readRemoteBindScope()).toBe('lan');
    writeSetting('remote.bindScope', 42);
    expect(readRemoteBindScope()).toBe('lan');
    writeSetting('remote.bindScope', null);
    expect(readRemoteBindScope()).toBe('lan');
  });

  it('resolveBindAddress：lan→0.0.0.0、loopback→127.0.0.1', () => {
    expect(resolveBindAddress('lan')).toBe('0.0.0.0');
    expect(resolveBindAddress('loopback')).toBe('127.0.0.1');
  });
});
