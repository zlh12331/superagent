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
