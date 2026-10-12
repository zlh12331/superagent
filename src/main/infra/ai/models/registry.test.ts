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
    it('未传 modelId：解析为默认供应商默认模型（deepseek-flash）', () => {
      const resolved = registry.resolve(undefined);

      expect(resolved.modelId).toBe('deepseek-flash');
      expect(resolved.providerKind).toBe('deepseek');
      expect(resolved.isRuntime).toBe(false);
      expect(resolved.capabilities.reasoning).toBe(true);
    });

    it('显式内置模型 id：同厂商跨模型查找（glm-5.3 → zhipu）', () => {
      const resolved = registry.resolve('glm-5.3');

      expect(resolved.modelId).toBe('glm-5.3');
      expect(resolved.providerKind).toBe('zhipu');
      expect(resolved.capabilities.reasoning).toBe(true);
    });

    it('显式快模型 id：MiMo UltraSpeed（高速档）', () => {
      const resolved = registry.resolve('mimo-v2.6-pro-ultraspeed');

      expect(resolved.providerKind).toBe('mimo');
      expect(resolved.modelId).toBe('mimo-v2.6-pro-ultraspeed');
    });

    it('未注册模型 id：回退默认供应商 + 原始 id 透传（兼容测试连接）', () => {
      const resolved = registry.resolve('custom-model-xyz');

      expect(resolved.modelId).toBe('custom-model-xyz');
      expect(resolved.providerKind).toBe('deepseek');
      expect(resolved.isRuntime).toBe(false);
    });

    it('显式深度适配模型（mimo-v2.6-pro）：解析到注册厂商', () => {
      const resolved = registry.resolve('mimo-v2.6-pro');

      expect(resolved.providerKind).toBe('mimo');
      expect(resolved.capabilities.reasoning).toBe(true);
    });

    it('思考模型（deepseek-v4-pro）：标记 reasoning + 思考强度配置（max）', () => {
      const resolved = registry.resolve('deepseek-v4-pro');

      expect(resolved.capabilities.reasoning).toBe(true);
      expect(resolved.generationConfig?.reasoningEffort).toBe('max');
    });

    it('模型能力上限：DeepSeek v4 输出 384K（官方），GLM-5.3 128K', () => {
      expect(registry.resolve('deepseek-flash').capabilities.maxOutputTokens).toBe(384_000);
      expect(registry.resolve('deepseek-v4-pro').capabilities.maxOutputTokens).toBe(384_000);
      expect(registry.resolve('glm-5.3').capabilities.maxOutputTokens).toBe(128_000);
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

    it('快照 timeoutMs 与内置 generationConfig 合并（不整组覆盖）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('deepseek', 'deepseek-v4-pro'),
        providerKind: 'deepseek',
        modelId: 'deepseek-v4-pro',
        timeoutMs: 600_000,
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('deepseek-v4-pro');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.generationConfig).toEqual({ reasoningEffort: 'max', timeoutMs: 600_000 });
    });

    it('快照未配置 timeoutMs：保持既有语义（generationConfig undefined）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('deepseek', 'my-coder'),
        providerKind: 'deepseek',
        modelId: 'my-coder',
        createdAt: 1_700_000_000_000,
      });

      expect(registry.resolve('my-coder').generationConfig).toBeUndefined();
    });

    it('快照覆盖同名内置模型：继承能力元数据（contextWindowSize / reasoning）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('deepseek', 'deepseek-v4-pro'),
        providerKind: 'deepseek',
        modelId: 'deepseek-v4-pro',
        baseUrl: 'https://proxy.example.com',
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('deepseek-v4-pro');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.capabilities.reasoning).toBe(true);
      expect(resolved.capabilities.contextWindowSize).toBe(1_000_000);
      expect(resolved.capabilities.maxOutputTokens).toBe(384_000);
      expect(resolved.generationConfig).toEqual({ reasoningEffort: 'max' });
    });

    it('快照覆盖同名内置模型且配置 timeoutMs：能力继承 + 生成参数合并（不全覆盖）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('deepseek', 'deepseek-v4-pro'),
        providerKind: 'deepseek',
        modelId: 'deepseek-v4-pro',
        timeoutMs: 600_000,
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('deepseek-v4-pro');

      expect(resolved.capabilities.reasoning).toBe(true);
      expect(resolved.generationConfig).toEqual({ reasoningEffort: 'max', timeoutMs: 600_000 });
    });

    it('自定义模型（id 无同名内置条目）：能力回落空对象（保守策略）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'my-private-model'),
        providerKind: 'openai',
        modelId: 'my-private-model',
        baseUrl: 'https://private.example.com',
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('my-private-model');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.capabilities).toEqual({});
      expect(resolved.generationConfig).toBeUndefined();
    });

    it('快照带 capabilitiesOverride：覆盖字段逐项覆盖内置值，其余字段保留内置', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('deepseek', 'deepseek-v4-pro'),
        providerKind: 'deepseek',
        modelId: 'deepseek-v4-pro',
        capabilitiesOverride: {
          contextWindowSize: 512_000,
          vision: false,
        },
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('deepseek-v4-pro');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.capabilities.contextWindowSize).toBe(512_000);
      expect(resolved.capabilities.vision).toBe(false);
      // 未覆盖字段保留内置清单值
      expect(resolved.capabilities.maxOutputTokens).toBe(384_000);
      expect(resolved.capabilities.reasoning).toBe(true);
    });

    it('自定义模型带 capabilitiesOverride：能力直接采用覆盖（无内置可回退）', () => {
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'my-private-model'),
        providerKind: 'openai',
        modelId: 'my-private-model',
        capabilitiesOverride: {
          contextWindowSize: 128_000,
          maxOutputTokens: 16_000,
          vision: true,
        },
        createdAt: 1_700_000_000_000,
      });

      const resolved = registry.resolve('my-private-model');

      expect(resolved.isRuntime).toBe(true);
      expect(resolved.capabilities).toEqual({
        contextWindowSize: 128_000,
        maxOutputTokens: 16_000,
        vision: true,
      });
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

    it('默认模型被停用 → resolve(undefined) 返回 available=false（对话主链路拦截）', () => {
      registry.registerDisabledModel('deepseek-flash');
      const resolved = registry.resolve(undefined);
      expect(resolved.available).toBe(false);
      expect(resolved.modelId).toBe('deepseek-flash');
    });

    it('默认模型未停用 → resolve(undefined) 正常可路由', () => {
      const resolved = registry.resolve(undefined);
      expect(resolved.available).toBe(true);
      expect(resolved.modelId).toBe('deepseek-flash');
    });
  });

  describe('listModels（设置 UI 下拉）', () => {
    it('列出全部内置模型（收紧后 11 条：deepseek 4 / zhipu 5 / mimo 3）', () => {
      const models = registry.listModels();

      expect(models).toHaveLength(BUILTIN_MODELS.length);
      expect(models.find((m) => m.id === 'deepseek-flash')).toMatchObject({
        label: 'DeepSeek V4.1 Flash（多模态）',
        providerKind: 'deepseek',
        isRuntime: false,
      });
      expect(models.find((m) => m.id === 'glm-5.3')).toMatchObject({
        providerKind: 'zhipu',
      });
      expect(models.find((m) => m.id === 'mimo-v2.6-pro')).toMatchObject({
        providerKind: 'mimo',
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
