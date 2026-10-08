// src/main/infra/storage/ai-pref.test.ts
// ai-pref 单测：用户选定模型的读取与回落（真实 SQLite 临时库，无业务 mock）
//
// 语义锁定：读取失败一律回落 undefined（调用方走默认模型），
// 不因设置损坏/库未初始化而抛错——对话主链路不能被设置读取拖垮。
// 与 settings-pref.test.ts 同一套「真实 better-sqlite3 临时目录」基建模式。

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSelectedModelId } from './ai-pref';
import { closeDb, initDb, resetDb } from './db';
import { writeSetting } from './settings-pref';

const mocks = vi.hoisted(() => ({
  mockGetPath: vi.fn(() => '/tmp/ai-pref-default'),
}));

vi.mock('electron', () => ({
  app: {
    getPath: mocks.mockGetPath,
    // initDb 的 resolveMigrationsDir 需要：dev 环境指向项目根 drizzle/
    getAppPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let tempDir: string;

describe('ai-pref（用户选定模型读取）', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ai-pref-'));
    mocks.mockGetPath.mockReturnValue(tempDir);
    initDb();
  });

  afterEach(async () => {
    await closeDb();
    resetDb();
    rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('未写入任何设置 → undefined（调用方回落默认模型）', () => {
    expect(readSelectedModelId()).toBeUndefined();
  });

  it('写入 ai.defaultModel → 原样读出', () => {
    writeSetting('ai', { defaultModel: 'gpt-4o', temperature: 0.7 });
    expect(readSelectedModelId()).toBe('gpt-4o');
  });

  it('defaultModel 为空串 → undefined（等价未设置，防空 id 进 registry）', () => {
    writeSetting('ai', { defaultModel: '' });
    expect(readSelectedModelId()).toBeUndefined();
  });

  it('defaultModel 为非字符串（损坏/旧版残留）→ undefined', () => {
    writeSetting('ai', { defaultModel: 42 });
    expect(readSelectedModelId()).toBeUndefined();
  });

  it('ai 键为非对象（损坏）→ undefined 不抛错', () => {
    writeSetting('ai', 'corrupted');
    expect(readSelectedModelId()).toBeUndefined();
  });
});
