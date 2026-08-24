// src/main/infra/ai/models/registry.test.ts
// ModelRegistry 单测：模型级解析 / 跨供应商查找 / 运行时快照
//
// 测试要点：
// 1. resolve(undefined) → 默认供应商默认模型（deepseek-v4-flash）
// 2. resolve(显式 id) → 跨供应商查找（gpt-4o → openai）
// 3. resolve(未注册 id) → 默认供应商 + 原始 id 透传（兼容测试连接）
// 4. 运行时快照：注册 / 覆盖内置 / 注销 / 显式 apiKey+baseUrl
// 5. listModels：内置 + 运行时快照

import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_MODELS, DEFAULT_MODEL_BY_KIND } from './builtin-models';
import { ModelRegistry } from './registry';
import { buildRuntimeSnapshotId } from './types';

function createRegistry(): ModelRegistry {
  return new ModelRegistry({
    entries: BUILTIN_MODELS,
    defaultModelByKind: DEFAULT_MODEL_BY_KIND,
    defaultKind: 'deepseek',
  });
}

describe('ModelRegistry', () => {
  let registry: ModelRegistry;

  beforeEach(() => {
    registry = createRegistry();
  });

  describe('resolve（模型级解析）', () => {
    it('未传 modelId：解析为默认供应商默认模型（deepseek-v4-flash）', () => {
      const resolved = registry.resolve(undefined);

      expect(resolved.modelId).toBe('deepseek-v4-flash');
      expect(resolved.providerKind).toBe('deepseek');
      expect(resolved.isRuntime).toBe(false);
      expect(resolved.capabilities.reasoning).toBe(true);
    });

    it('显式内置模型 id：跨供应商查找（gpt-4o → openai）', () => {
      const resolved = registry.resolve('gpt-4o');

      expect(resolved.modelId).toBe('gpt-4o');
      expect(resolved.providerKind).toBe('openai');
      expect(resolved.capabilities.vision).toBe(true);
    });

    it('显式快模型 id：携带 fastOnly 能力标记', () => {
      const resolved = registry.resolve('gpt-4o-mini');

      expect(resolved.providerKind).toBe('openai');
      expect(resolved.capabilities.fastOnly).toBe(true);
    });

    it('未注册模型 id：回退默认供应商 + 原始 id 透传（兼容测试连接）', () => {
      const resolved = registry.resolve('custom-model-xyz');

      expect(resolved.modelId).toBe('custom-model-xyz');
      expect(resolved.providerKind).toBe('deepseek');
      expect(resolved.isRuntime).toBe(false);
    });

    it('本地供应商模型（ollama）：无需 API Key', () => {
      const resolved = registry.resolve('qwen2.5-coder:7b');

      expect(resolved.providerKind).toBe('ollama');
      expect(resolved.explicitApiKey).toBeUndefined();
    });

    it('思考模型（deepseek-v4-pro）：标记 reasoning + 思考强度配置（max）', () => {
      const resolved = registry.resolve('deepseek-v4-pro');

      expect(resolved.capabilities.reasoning).toBe(true);
      expect(resolved.generationConfig?.reasoningEffort).toBe('max');
    });

    it('模型能力上限：DeepSeek v4 输出 384K（官方），GPT-4o 16K', () => {
      expect(registry.resolve('deepseek-v4-flash').capabilities.maxOutputTokens).toBe(384_000);
      expect(registry.resolve('deepseek-v4-pro').capabilities.maxOutputTokens).toBe(384_000);
      expect(registry.resolve('gpt-4o').capabilities.maxOutputTokens).toBe(16_384);
    });

    it('旧版模型（deepseek-chat）：保留兼容条目，非思考模型', () => {
      const resolved = registry.resolve('deepseek-chat');

      expect(resolved.modelId).toBe('deepseek-chat');
      expect(resolved.capabilities.reasoning).toBeUndefined();
    });
  });

  describe('运行时快照（手动配置的模型）', () => {
    it('注册后解析：isRuntime=true + 显式 apiKey/baseUrl 透传', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('deepseek', 'my-custom-endpoint'),
        providerKind: 'deepseek',
        modelId: 'my-custom-endpoint',
        apiKey: 'sk-custom',
        baseUrl: 'https://custom.api.com',
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('my-custom-endpoint');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.providerKind).toBe('deepseek');
      expect(resolved.explicitApiKey).toBe('sk-custom');
      expect(resolved.explicitBaseUrl).toBe('https://custom.api.com');
    });

    it('快照覆盖内置模型（同 modelId 优先取快照）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'gpt-4o'),
        providerKind: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://proxy.example.com',
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('gpt-4o');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.explicitBaseUrl).toBe('https://proxy.example.com');
    });

    it('注销后解析回退内置条目', () => {
      const snapshotId = buildRuntimeSnapshotId('openai', 'gpt-4o');
      registry.registerRuntimeModel({
        id: snapshotId,
        providerKind: 'openai',
        modelId: 'gpt-4o',
        baseUrl: 'https://proxy.example.com',
        createdAt: 1_700_000_000_000,
      });
      registry.unregisterRuntimeModel(snapshotId);

      const resolved = registry.resolve('gpt-4o');

      expect(resolved.isRuntime).toBe(false);
      expect(resolved.explicitBaseUrl).toBeUndefined();
    });

    it('注销不存在的快照：幂等不抛错', () => {
      expect(() => registry.unregisterRuntimeModel('$runtime|nonexistent')).not.toThrow();
    });
  });

  describe('停用模型（registerDisabledModel / available）', () => {
    it('标记停用 → resolve 返回 available=false（不落入任意 id 透传兜底）', () => {
      registry.registerDisabledModel('my-custom-model');

      const resolved = registry.resolve('my-custom-model');

      expect(resolved.available).toBe(false);
      expect(resolved.modelId).toBe('my-custom-model');
    });

    it('取消停用 → resolve 恢复可路由（available=true）', () => {
      registry.registerDisabledModel('my-custom-model');
      registry.unregisterDisabledModel('my-custom-model');

      const resolved = registry.resolve('my-custom-model');

      expect(resolved.available).toBe(true);
    });

    it('isModelDisabled 反映停用状态', () => {
      expect(registry.isModelDisabled('my-custom-model')).toBe(false);
      registry.registerDisabledModel('my-custom-model');
      expect(registry.isModelDisabled('my-custom-model')).toBe(true);
    });

    it('停用内置模型 id → 返回 available=false（关闭覆盖内置）', () => {
      registry.registerDisabledModel('gpt-4o');
      expect(registry.resolve('gpt-4o').available).toBe(false);
    });

    it('默认模型 resolve(undefined) 不受停用集合影响', () => {
      registry.registerDisabledModel('deepseek-v4-flash');
      const resolved = registry.resolve(undefined);
      expect(resolved.available).toBe(true);
      expect(resolved.modelId).toBe('deepseek-v4-flash');
    });
  });

  describe('listModels（设置 UI 下拉）', () => {
    it('列出全部内置模型（10 个）', () => {
      const models = registry.listModels();

      expect(models).toHaveLength(BUILTIN_MODELS.length);
      expect(models.find((m) => m.id === 'deepseek-v4-flash')).toMatchObject({
        label: 'DeepSeek V4 Flash',
        providerKind: 'deepseek',
        isRuntime: false,
      });
    });

    it('包含运行时快照模型且标记 isRuntime', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'custom-model'),
        providerKind: 'openai',
        modelId: 'custom-model',
        createdAt: 1_700_000_000_000,
      });

      const models = registry.listModels();
      const runtime = models.find((m) => m.id === 'custom-model');

      expect(runtime).toMatchObject({
        providerKind: 'openai',
        isRuntime: true,
      });
    });
  });
});
