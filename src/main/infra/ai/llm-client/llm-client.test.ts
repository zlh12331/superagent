// src/main/infra/ai/llm-client/llm-client.test.ts
// LlmClient 单测：模型级路由 / per-model 缓存 / 运行时快照透传 / generateText 重试
//
// 测试要点：
// 1. getModel(undefined) → 默认供应商默认模型
// 2. getModel(显式 id) → 跨供应商解析（gpt-4o-mini → openai）
// 3. per-model 缓存：同模型不重复创建工厂
// 4. 未注册模型 → 默认供应商 + 原始 id 透传
// 5. 运行时快照：explicitApiKey/baseUrl 透传到 createProviderFactory
// 6. generateText：成功路径 + 可重试错误重试
// 7. reset：清空 per-model 缓存

import type { LanguageModel } from 'ai';
import { APICallError } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  BUILTIN_MODELS,
  buildRuntimeSnapshotId,
  DEFAULT_MODEL_BY_KIND,
  ModelRegistry,
} from '../models';
import type { ProviderKind } from '../providers/types';
import { LlmClient } from './llm-client';

const mocks = vi.hoisted(() => {
  const mockGenerateText = vi.fn();
  const mockGenerateObject = vi.fn();
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockGenerateText, mockGenerateObject, mockLogger };
});

// mock 'ai'：保留 APICallError 等真实导出，仅替换 generateText / generateObject
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: mocks.mockGenerateText,
    generateObject: mocks.mockGenerateObject,
  };
});

// mock logger：避免触发真实 electron-log 初始化
vi.mock('../../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

/** 构造 LlmClient（DI fake：createProviderFactory 返回可追踪的工厂） */
function createClient() {
  const registry = new ModelRegistry({
    entries: BUILTIN_MODELS,
    defaultModelByKind: DEFAULT_MODEL_BY_KIND,
    defaultKind: 'deepseek',
  });
  const createProviderFactory = vi.fn(
    async (kind: ProviderKind): Promise<(modelId: string) => LanguageModel> => {
      return (modelId: string) => ({ id: `${kind}:${modelId}` }) as unknown as LanguageModel;
    },
  );
  const client = new LlmClient({ modelRegistry: registry, createProviderFactory });
  return { client, registry, createProviderFactory };
}

describe('LlmClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getModel（模型级路由）', () => {
    it('未传 modelId：解析为默认供应商默认模型（deepseek-v4-flash）', async () => {
      const { client, createProviderFactory } = createClient();

      const model = await client.getModel();

      expect(createProviderFactory).toHaveBeenCalledWith('deepseek');
      expect(model).toMatchObject({ id: 'deepseek:deepseek-v4-flash' });
    });

    it('显式模型 id：跨供应商解析（gpt-4o-mini → openai）', async () => {
      const { client, createProviderFactory } = createClient();

      const model = await client.getModel('gpt-4o-mini');

      expect(createProviderFactory).toHaveBeenCalledWith('openai');
      expect(model).toMatchObject({ id: 'openai:gpt-4o-mini' });
    });

    it('per-model 缓存：同模型第二次调用不重复创建工厂', async () => {
      const { client, createProviderFactory } = createClient();

      const first = await client.getModel('deepseek-v4-pro');
      const second = await client.getModel('deepseek-v4-pro');

      expect(second).toBe(first);
      expect(createProviderFactory).toHaveBeenCalledTimes(1);
      expect(client.getModelCacheSize()).toBe(1);
    });

    it('未注册模型 id：回退默认供应商 + 原始 id 透传', async () => {
      const { client, createProviderFactory } = createClient();

      const model = await client.getModel('custom-model-xyz');

      expect(createProviderFactory).toHaveBeenCalledWith('deepseek');
      expect(model).toMatchObject({ id: 'deepseek:custom-model-xyz' });
    });

    it('运行时快照：explicitApiKey / explicitBaseUrl 透传到工厂', async () => {
      const { client, registry, createProviderFactory } = createClient();
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'custom-endpoint'),
        providerKind: 'openai',
        modelId: 'custom-endpoint',
        apiKey: 'sk-custom',
        baseUrl: 'https://custom.api.com',
        createdAt: 1_700_000_000_000,
      });

      const model = await client.getModel('custom-endpoint');

      expect(createProviderFactory).toHaveBeenCalledWith('openai', {
        apiKey: 'sk-custom',
        baseUrl: 'https://custom.api.com',
      });
      expect(model).toMatchObject({ id: 'openai:custom-endpoint' });
    });

    it('reset：清空 per-model 缓存，重新创建实例', async () => {
      const { client, createProviderFactory } = createClient();

      await client.getModel('deepseek-v4-pro');
      client.reset();
      await client.getModel('deepseek-v4-pro');

      expect(createProviderFactory).toHaveBeenCalledTimes(2);
      expect(client.getModelCacheSize()).toBe(1);
    });

    it('invalidateModel：只失效指定模型，其他缓存保留', async () => {
      const { client, createProviderFactory } = createClient();

      await client.getModel('deepseek-v4-flash');
      await client.getModel('gpt-4o');
      expect(client.getModelCacheSize()).toBe(2);

      client.invalidateModel('deepseek-v4-flash');

      expect(client.getModelCacheSize()).toBe(1);
      // 失效的模型重新创建，未失效的 gpt-4o 命中缓存
      await client.getModel('deepseek-v4-flash');
      await client.getModel('gpt-4o');
      expect(createProviderFactory).toHaveBeenCalledTimes(3);
    });
  });

  describe('generateText（会话外 side query）', () => {
    it('成功路径：返回 text + usage 映射', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({
        text: 'hello',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      });

      const result = await client.generateText({ prompt: 'hi' });

      expect(result.text).toBe('hello');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('usage 为空对象：返回 undefined', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'hi', usage: {} });

      const result = await client.generateText({ prompt: 'hi' });

      expect(result.usage).toBeUndefined();
    });

    it('可重试错误：重试后成功', async () => {
      vi.useFakeTimers();
      const { client } = createClient();
      mocks.mockGenerateText
        .mockRejectedValueOnce(
          new APICallError({
            message: 'HTTP 429',
            url: 'https://api.example.com/v1/chat/completions',
            requestBodyValues: {},
            statusCode: 429,
          }),
        )
        .mockResolvedValueOnce({ text: 'retried', usage: {} });

      const promise = client.generateText({ prompt: 'hi', maxAttempts: 3 });
      await vi.advanceTimersByTimeAsync(5000);

      await expect(promise).resolves.toMatchObject({ text: 'retried' });
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
    });

    it('不可重试错误：不重试，直接抛出', async () => {
      const { client } = createClient();
      const error = new APICallError({
        message: 'HTTP 401',
        url: 'https://api.example.com/v1/chat/completions',
        requestBodyValues: {},
        statusCode: 401,
      });
      mocks.mockGenerateText.mockRejectedValue(error);

      await expect(client.generateText({ prompt: 'hi' })).rejects.toBe(error);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('模型级 maxRetries：控制重试次数（maxRetries=1 → 最多 2 次尝试）', async () => {
      vi.useFakeTimers();
      try {
        // 自定义注册表：deepseek-v4-flash 附加 maxRetries=1
        const registry = new ModelRegistry({
          entries: BUILTIN_MODELS.map((entry) =>
            entry.id === 'deepseek-v4-flash'
              ? { ...entry, generationConfig: { reasoningEffort: 'max', maxRetries: 1 } }
              : entry,
          ),
          defaultModelByKind: DEFAULT_MODEL_BY_KIND,
          defaultKind: 'deepseek',
        });
        const createProviderFactory = vi.fn(
          async (kind: ProviderKind): Promise<(modelId: string) => LanguageModel> => {
            return (modelId: string) => ({ id: `${kind}:${modelId}` }) as unknown as LanguageModel;
          },
        );
        const client = new LlmClient({ modelRegistry: registry, createProviderFactory });
        const retryable = new APICallError({
          message: 'HTTP 500',
          url: 'https://api.example.com/v1/chat/completions',
          requestBodyValues: {},
          statusCode: 500,
        });
        mocks.mockGenerateText.mockRejectedValue(retryable);

        const promise = client.generateText({ prompt: 'hi' });
        const assertion = expect(promise).rejects.toBe(retryable);
        await vi.advanceTimersByTimeAsync(5000);
        await assertion;
        // maxRetries=1 → 首次 + 1 次重试 = 2 次调用
        expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('generateJson（结构化输出）', () => {
    it('成功路径：返回 schema 约束的对象', async () => {
      const { client } = createClient();
      mocks.mockGenerateObject.mockResolvedValue({ object: { title: '测试' } });

      const schema = z.object({ title: z.string() });
      const result = await client.generateJson({ schema, prompt: '提取标题' });

      expect(result).toEqual({ title: '测试' });
      expect(mocks.mockGenerateObject).toHaveBeenCalledTimes(1);
      // schema 透传给 generateObject
      const args = mocks.mockGenerateObject.mock.calls[0]?.[0] as { schema: unknown } | undefined;
      expect(args?.schema).toBe(schema);
    });

    it('可重试错误：重试后成功', async () => {
      vi.useFakeTimers();
      try {
        const { client } = createClient();
        mocks.mockGenerateObject
          .mockRejectedValueOnce(
            new APICallError({
              message: 'HTTP 429',
              url: 'https://api.example.com/v1/chat/completions',
              requestBodyValues: {},
              statusCode: 429,
            }),
          )
          .mockResolvedValueOnce({ object: { ok: true } });

        const promise = client.generateJson({
          schema: z.object({ ok: z.boolean() }),
          prompt: 'hi',
        });
        await vi.advanceTimersByTimeAsync(5000);

        await expect(promise).resolves.toEqual({ ok: true });
        expect(mocks.mockGenerateObject).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('generateText（模型级生成参数适配，DeepSeek 思考模式）', () => {
    /** 获取最近一次 generateText 调用的参数（mock 无参类型需 cast） */
    function getLastGenerateTextArgs(): Record<string, unknown> {
      const calls = mocks.mockGenerateText.mock.calls as unknown[][];
      const args = calls[calls.length - 1]?.[0];
      if (args === undefined) {
        throw new Error('generateText 未被调用');
      }
      return args as Record<string, unknown>;
    }

    it('reasoning 模型：注入 providerOptions.reasoningEffort（max），不传采样参数', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });

      // 默认模型 flash 即 reasoning 模型，思考强度 max
      await client.generateText({ prompt: 'hi' });

      const args = getLastGenerateTextArgs();
      // 思考强度经 providerOptions 注入（provider name = ProviderKind）
      expect(args['providerOptions']).toEqual({ deepseek: { reasoningEffort: 'max' } });
      // 思考模式不支持采样参数：不传 temperature / topP
      expect(args['temperature']).toBeUndefined();
      expect(args['topP']).toBeUndefined();
    });

    it('reasoning 模型未配置 reasoningEffort：不注入 providerOptions', async () => {
      // deepseek-reasoner（旧版兼容条目）无 generationConfig
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });

      await client.generateText({ model: 'deepseek-reasoner', prompt: 'hi' });

      const args = getLastGenerateTextArgs();
      expect(args['providerOptions']).toBeUndefined();
      expect(args['temperature']).toBeUndefined();
    });

    it('输出上限取模型能力：DeepSeek v4（384K）不被全局 64K 封顶砍掉', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });

      await client.generateText({ model: 'deepseek-v4-flash', prompt: 'hi' });

      const args = getLastGenerateTextArgs();
      // window 1M − prompt(≈2) − margin(50K) ≈ 950K；min(384K, 950K) = 384K
      expect(args['maxOutputTokens']).toBe(384_000);
    });

    it('非 reasoning 模型配置采样参数：应用 temperature / topP / maxTokens', async () => {
      // 自定义注册表：给 gpt-4o 附加采样参数配置
      const registry = new ModelRegistry({
        entries: BUILTIN_MODELS.map((entry) =>
          entry.id === 'gpt-4o'
            ? {
                ...entry,
                generationConfig: { temperature: 0.7, topP: 0.9, maxTokens: 100 },
              }
            : entry,
        ),
        defaultModelByKind: DEFAULT_MODEL_BY_KIND,
        defaultKind: 'deepseek',
      });
      const createProviderFactory = vi.fn(
        async (kind: ProviderKind): Promise<(modelId: string) => LanguageModel> => {
          return (modelId: string) => ({ id: `${kind}:${modelId}` }) as unknown as LanguageModel;
        },
      );
      const client = new LlmClient({ modelRegistry: registry, createProviderFactory });
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });

      await client.generateText({ model: 'gpt-4o', prompt: 'hi' });

      const args = getLastGenerateTextArgs();
      expect(args['temperature']).toBe(0.7);
      expect(args['topP']).toBe(0.9);
      expect(args['maxOutputTokens']).toBe(100);
      expect(args['providerOptions']).toBeUndefined();
    });
  });
});
