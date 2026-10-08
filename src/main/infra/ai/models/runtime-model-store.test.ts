// src/main/infra/ai/models/runtime-model-store.test.ts
// RuntimeModelStore 单测：持久化 / keychain / 注册 / 启动加载
//
// 接线背景：生产消费方 = settings.handler（模型配置 add/update/remove/list）
// + models.handler（list）+ ServiceContainer init（loadAll，LLM 首次调用前）。
// 本文件用内存 DB + mock electron/safeStorage（基础设施 mock），停用/重启
// 恢复语义（clearRuntimeModels + loadAll）是生产启动路径的结构性回归。

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

// mock getDb：内存数据库（drizzle 迁移，schema.ts 单一真源）
import { createTestDb } from '../../storage/test-utils';

function createInMemoryDb() {
  return createTestDb();
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
    // 占位值刻意避开真实密钥形态（sk- 前缀等）：测试只验证「存什么返回什么」
    const placeholderKey = 'test-only-placeholder-key';
    await store.add({
      modelId: 'my-coder',
      providerKind: 'openai',
      apiKey: placeholderKey,
    });

    expect(mocks.mockEncrypt).toHaveBeenCalled();
    // keychain 写入的 key 应含模型 id（加密前字符串）
    const encryptedInput = mocks.mockEncrypt.mock.calls[0]?.[0] as string | undefined;
    expect(encryptedInput).toBe(placeholderKey);
  });

  it('add 带 timeoutMs：落库 + 注册表快照携带（resolve 并入 generationConfig）', async () => {
    await store.add({
      modelId: 'my-coder',
      providerKind: 'deepseek',
      timeoutMs: 600_000,
    });

    expect((await store.list())[0]).toMatchObject({ modelId: 'my-coder', timeoutMs: 600_000 });
    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(true);
    expect(resolved.generationConfig).toEqual({ timeoutMs: 600_000 });
  });

  it('add 带 apiFormat：落库 + 快照携带（resolve 透传给工厂做协议路由）', async () => {
    await store.add({
      modelId: 'my-responses-model',
      providerKind: 'deepseek',
      baseUrl: 'https://gw.example.com',
      apiFormat: 'openai-responses',
    });

    expect((await store.list())[0]).toMatchObject({ apiFormat: 'openai-responses' });
    expect(modelRegistry.resolve('my-responses-model').apiFormat).toBe('openai-responses');
  });

  it('add 不带 apiFormat（存量语义）：记录无该字段 + resolve 为 undefined（工厂按 kind 默认）', async () => {
    await store.add({ modelId: 'legacy-model', providerKind: 'deepseek' });

    // undefined 而非 'openai-chat'：把「未表态」与「显式选 chat」区分开，
    // 前者交 providerKind 决定（服务商模式语义）
    expect((await store.list())[0]?.apiFormat).toBeUndefined();
    expect(modelRegistry.resolve('legacy-model').apiFormat).toBeUndefined();
  });

  it('update：apiFormat 落库 + 注册表重建为最新值', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });

    await store.update({ modelId: 'my-coder', apiFormat: 'anthropic-messages' });

    expect((await store.get('my-coder'))?.apiFormat).toBe('anthropic-messages');
    expect(modelRegistry.resolve('my-coder').apiFormat).toBe('anthropic-messages');
  });

  it('loadAll：apiFormat 随快照恢复（重启后协议选择仍生效）', async () => {
    await store.add({
      modelId: 'my-responses-model',
      providerKind: 'deepseek',
      apiFormat: 'openai-responses',
    });

    // 模拟重启：清空注册表内存态后 loadAll 从 DB 重建
    modelRegistry.clearRuntimeModels();
    await new RuntimeModelStore().loadAll();

    expect(modelRegistry.resolve('my-responses-model').apiFormat).toBe('openai-responses');
  });

  it('DB 脏值（非法 apiFormat）：按未设置处理（回落 kind 默认，不抛错）', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });
    // 直接写非法值模拟历史脏数据（绕过入参校验）
    const { getDb } = await import('../../storage/db');
    const { runtimeModels } = await import('../../storage/schema');
    const { eq } = await import('drizzle-orm');
    getDb()
      .update(runtimeModels)
      .set({ apiFormat: 'not-a-format' })
      .where(eq(runtimeModels.modelId, 'my-coder'))
      .run();

    expect((await store.get('my-coder'))?.apiFormat).toBeUndefined();
  });

  it('update：timeoutMs 三态（设置 / null 清除 / 省略不改）', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });

    // 设置
    await store.update({ modelId: 'my-coder', timeoutMs: 300_000 });
    expect((await store.list())[0]).toMatchObject({ timeoutMs: 300_000 });
    expect(modelRegistry.resolve('my-coder').generationConfig).toEqual({ timeoutMs: 300_000 });

    // 清除（null → 落 NULL，回不限制）
    await store.update({ modelId: 'my-coder', timeoutMs: null });
    expect((await store.list())[0]?.timeoutMs).toBeUndefined();
    expect(modelRegistry.resolve('my-coder').generationConfig).toBeUndefined();

    // 省略不改（更新其他字段时超时保持）
    await store.update({ modelId: 'my-coder', timeoutMs: 300_000 });
    await store.update({ modelId: 'my-coder', displayName: '编码器' });
    expect((await store.list())[0]).toMatchObject({ timeoutMs: 300_000, displayName: '编码器' });
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

  it('update：displayName/baseUrl 落库 + 注册表重建最新快照', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });

    await store.update({
      modelId: 'my-coder',
      displayName: '我的编码器',
      baseUrl: 'https://updated.api.com',
    });

    const record = await store.get('my-coder');
    expect(record).toMatchObject({
      modelId: 'my-coder',
      displayName: '我的编码器',
      baseUrl: 'https://updated.api.com',
    });
    // 注册表已重建为最新 baseUrl
    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(true);
    expect(resolved.explicitBaseUrl).toBe('https://updated.api.com');
  });

  it('update：isEnabled=false 停用 → 注销注册 + 登记停用（不可路由）', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });

    await store.update({ modelId: 'my-coder', isEnabled: false });

    expect((await store.get('my-coder'))?.isEnabled).toBe(false);
    // 停用后注销快照 + 登记停用身份：resolve 返回 available=false（不再透传兜底）
    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(false);
    expect(resolved.available).toBe(false);
  });

  it('update：isEnabled=true 重新启用 → 重新注册 + 清除停用身份', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });
    await store.update({ modelId: 'my-coder', isEnabled: false });
    expect(modelRegistry.resolve('my-coder').available).toBe(false);

    await store.update({ modelId: 'my-coder', isEnabled: true });

    expect((await store.get('my-coder'))?.isEnabled).toBe(true);
    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(true);
    expect(resolved.available).toBe(true);
  });

  it('update 不存在的模型：抛 NOT_FOUND', async () => {
    await expect(store.update({ modelId: 'ghost' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('update：apiKey 传入时写入 keychain', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'openai' });
    vi.clearAllMocks();

    await store.update({ modelId: 'my-coder', apiKey: 'sk-updated' });

    expect(mocks.mockEncrypt).toHaveBeenCalledWith('sk-updated');
  });

  it('loadAll：启动时注册全部已保存模型', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'openai' });
    // 模拟重启：新 store 实例 loadAll
    const freshStore = new RuntimeModelStore();
    await freshStore.loadAll();

    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(true);
  });

  it('loadAll：停用模型不注册 + 恢复停用身份（重启后关闭仍生效）', async () => {
    await store.add({ modelId: 'my-coder', providerKind: 'deepseek' });
    await store.update({ modelId: 'my-coder', isEnabled: false });

    // 模拟重启：新 store 实例 + 清空注册表（内存态丢失）后 loadAll 恢复
    modelRegistry.clearRuntimeModels();
    const freshStore = new RuntimeModelStore();
    await freshStore.loadAll();

    const resolved = modelRegistry.resolve('my-coder');
    expect(resolved.isRuntime).toBe(false);
    expect(resolved.available).toBe(false);
  });
});
