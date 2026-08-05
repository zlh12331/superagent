// src/main/infra/ai/models/runtime-model-store.test.ts
// RuntimeModelStore 单测：持久化 / keychain / 注册 / 启动加载

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron：safeStorage（keychain 依赖）+ app.getPath（db 依赖）
const mocks = vi.hoisted(() => ({
  mockEncrypt: vi.fn((value: string) => Buffer.from(`enc:${value}`)),
  mockDecrypt: vi.fn((buffer: Buffer) => buffer.toString().replace(/^enc:/, '')),
  mockIsEncryptionAvailable: vi.fn(() => true),
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
}));

vi.mock('electron', () => ({
  app: mocks.mockApp,
  safeStorage: {
    isEncryptionAvailable: mocks.mockIsEncryptionAvailable,
    encryptString: mocks.mockEncrypt,
    decryptString: mocks.mockDecrypt,
  },
}));

// mock getDb：内存数据库（建表 SQL 单一真源 schema-sql.ts，与生产共用）
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { schema } from '../../storage/schema';
import { SCHEMA_SQL } from '../../storage/schema-sql';

function createInMemoryDb() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  sqlite.exec(SCHEMA_SQL);
  return { db, sqlite };
}

vi.mock('../../storage/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../storage/db')>();
  let memoryDb: ReturnType<typeof createInMemoryDb> | null = null;
  return {
    ...actual,
    getDb: () => {
      if (memoryDb === null) {
        memoryDb = createInMemoryDb();
      }
      return memoryDb.db;
    },
    resetDb: () => {
      memoryDb = null;
    },
  };
});

import { resetDb } from '../../storage/db';
import { modelRegistry } from './index';
import { RuntimeModelStore } from './runtime-model-store';

describe('RuntimeModelStore', () => {
  let store: RuntimeModelStore;

  beforeAll(() => {
    resetDb();
    // keychain 写真实文件：指向临时目录（避免污染 userData）
    mocks.mockApp.getPath.mockReturnValue(mkdtempSync(join(tmpdir(), 'code-agent-rtm-test-')));
  });

  beforeEach(() => {
    resetDb();
    // 清理 modelRegistry 单例的运行时快照（跨测试污染）
    modelRegistry.clearRuntimeModels();
    store = new RuntimeModelStore();
    vi.clearAllMocks();
  });

  it('add：持久化 + 注册到 ModelRegistry（isRuntime 解析）', async () => {
    await store.add({
      modelId: 'my-coder',
      providerKind: 'deepseek',
      baseUrl: 'https://custom.api.com',
    });

    // 持久化列表
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      modelId: 'my-coder',
      providerKind: 'deepseek',
      baseUrl: 'https://custom.api.com',
    });

    // 注册后按模型 id 解析为运行时模型
    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(true);
    expect(resolved.providerKind).toBe('deepseek');
    expect(resolved.explicitBaseUrl).toBe('https://custom.api.com');
  });

  it('add 带 apiKey：写入 keychain（runtime:<modelId>）', async () => {
    await store.add({
      modelId: 'my-coder',
      providerKind: 'openai',
      apiKey: 'sk-custom',
    });

    expect(mocks.mockEncrypt).toHaveBeenCalled();
    // keychain 写入的 key 应含模型 id（加密前字符串）
    const encryptedInput = mocks.mockEncrypt.mock.calls[0]?.[0] as string | undefined;
    expect(encryptedInput).toBe('sk-custom');
  });

  it('remove：DB 删除 + 注销注册（解析回退默认）', async () => {
    await store.add({
      modelId: 'my-coder',
      providerKind: 'deepseek',
      baseUrl: 'https://custom.api.com',
    });

    await store.remove('my-coder');

    expect(await store.list()).toHaveLength(0);
    // 注销后：显式解析回退默认供应商透传（非运行时）
    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(false);
  });

  it('remove 不存在的模型：幂等不抛错', async () => {
    await expect(store.remove('nonexistent')).resolves.toBeUndefined();
  });

  it('loadAll：启动时注册全部已保存模型', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'openai' });
    // 模拟重启：新 store 实例 loadAll
    const freshStore = new RuntimeModelStore();
    await freshStore.loadAll();

    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(true);
  });
});
