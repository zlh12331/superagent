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
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockGenerateText, mockLogger };
});

// mock 'ai'：保留 APICallError 等真实导出，仅替换 generateText
// （2026-09-11：结构性输出已并入 generateText + Output.object，不再 mock generateObject）
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: mocks.mockGenerateText,
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
  // 合法 v4 model（wrap 后 modelId/provider 才是真实 SDK 语义；id 字段会被丢弃）
  const createProviderFactory = vi.fn(
    async (kind: ProviderKind): Promise<(modelId: string) => LanguageModel> => {
      return (modelId: string) =>
        ({
          specificationVersion: 'v4',
          provider: kind,
          modelId,
          doGenerate: async () => ({ text: 'mock' }),
          doStream: async () => ({ stream: {} }),
        }) as unknown as LanguageModel;
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
      expect(model).toMatchObject({ modelId: 'deepseek-v4-flash' });
    });

    it('显式模型 id：跨供应商解析（gpt-4o-mini → openai）', async () => {
      const { client, createProviderFactory } = createClient();

      const model = await client.getModel('gpt-4o-mini');

      expect(createProviderFactory).toHaveBeenCalledWith('openai');
      expect(model).toMatchObject({ modelId: 'gpt-4o-mini' });
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
      expect(model).toMatchObject({ modelId: 'custom-model-xyz' });
    });

    it('已停用模型：getModel 抛 MODEL_DISABLED（不落入透传兜底）', async () => {
      const { client, registry, createProviderFactory } = createClient();
      registry.registerDisabledModel('my-disabled-model');

      await expect(client.getModel('my-disabled-model')).rejects.toMatchObject({
        code: 'MODEL_DISABLED',
      });
      expect(createProviderFactory).not.toHaveBeenCalled();
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
      expect(model).toMatchObject({ modelId: 'custom-endpoint' });
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

    it('SDK 内置 model call 重试已关闭：重试由本层 retryWithBackoff 独占', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });

      await client.generateText({ prompt: 'hi', maxAttempts: 1 });

      // 两层重试相乘会把 maxAttempts 放大成 maxAttempts × (1 + SDK maxRetries)
      expect(mocks.mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 }),
      );
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
      // 2026-09-11 迁移：结构化输出改走 generateText + Output.object，
      // 结果位于 result.output（原 generateObject 的 result.object）
      mocks.mockGenerateText.mockResolvedValue({ output: { title: '测试' } });

      const schema = z.object({ title: z.string() });
      const result = await client.generateJson({ schema, prompt: '提取标题' });

      expect(result).toEqual({ title: '测试' });
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
      // schema 经 Output.object 包装后传入 output 参数。
      // 断言 output.name 而非内部 schema 字段：Output.object 是不透明的描述符
      // （Object.keys = name/responseFormat/parseCompleteOutput/…），schema 封装在
      // parse 闭包内，属实现细节；name 才是稳定契约。
      const args = mocks.mockGenerateText.mock.calls[0]?.[0] as
        | { output?: { readonly name?: string } }
        | undefined;
      expect(args?.output?.name).toBe('object');
      // SDK 内置重试关闭：side query 重试由本层 retryWithBackoff 独占
      expect(args).toEqual(expect.objectContaining({ maxRetries: 0 }));
    });

    it('可重试错误：重试后成功', async () => {
      vi.useFakeTimers();
      try {
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
          .mockResolvedValueOnce({ output: { ok: true } });

        const promise = client.generateJson({
          schema: z.object({ ok: z.boolean() }),
          prompt: 'hi',
        });
        await vi.advanceTimersByTimeAsync(5000);

        await expect(promise).resolves.toEqual({ ok: true });
        expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
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

describe('LlmClient 批次2 缺口补全（降级链/覆盖透传/参数展开/超时接入）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /** 构造带 code 的网络错误（undici/node 网络层错误码） */
  function networkError(code: string): Error {
    return Object.assign(new Error(`network ${code}`), { code });
  }

  /** 构造指定状态码的 APICallError */
  function apiError(
    statusCode: number | undefined,
    extra?: { isRetryable?: boolean },
  ): APICallError {
    return new APICallError({
      message: `HTTP ${statusCode ?? 'unknown'}`,
      url: 'https://api.example.com/v1/chat/completions',
      requestBodyValues: {},
      // exactOptionalPropertyTypes：statusCode 为 undefined 时条件展开（不显式传 undefined）
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...extra,
    });
  }

  describe('ModelFallback 降级链', () => {
    // 5xx/网络错误是“可重试 + 可降级”双通道：内部 retryWithBackoff 会先重试。
    // 为聚焦降级判定，统一传 maxAttempts: 1（禁重试），错误直接冒泡到降级层。

    it('显式模型 + 5xx：降级默认模型重试并成功', async () => {
      const { client } = createClient();
      mocks.mockGenerateText
        .mockRejectedValueOnce(apiError(502))
        .mockResolvedValueOnce({ text: 'fallback ok', usage: {} });

      const result = await client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 });

      expect(result.text).toBe('fallback ok');
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
      // 第二次调用使用默认模型（deepseek-v4-flash）
      const secondArgs = mocks.mockGenerateText.mock.calls[1]?.[0] as
        | { model: { modelId: string } }
        | undefined;
      expect(secondArgs?.model.modelId).toBe('deepseek-v4-flash');
      expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-4o', fallbackModel: 'deepseek-v4-flash' }),
        expect.stringContaining('ModelFallback'),
      );
    });

    it('显式模型 + 网络错误（ECONNRESET）：降级默认模型', async () => {
      const { client } = createClient();
      mocks.mockGenerateText
        .mockRejectedValueOnce(networkError('ECONNRESET'))
        .mockResolvedValueOnce({ text: 'ok', usage: {} });

      await client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 });

      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
    });

    it('网络错误码白名单：ECONNREFUSED/ETIMEDOUT/UND_ERR_* 均可降级', async () => {
      const { client } = createClient();
      const codes = [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_SOCKET',
      ];
      for (const code of codes) {
        mocks.mockGenerateText
          .mockRejectedValueOnce(networkError(code))
          .mockResolvedValueOnce({ text: 'ok', usage: {} });
        const result = await client.generateText({
          model: 'gpt-4o',
          prompt: `p-${code}`,
          maxAttempts: 1,
        });
        expect(result.text).toBe('ok');
      }
      // 5 个码各触发一次降级（每次 2 次调用）
      expect(mocks.mockGenerateText.mock.calls.length).toBe(10);
    });

    it('白名单外错误码（ECONNABORTED）：不降级直接抛', async () => {
      const { client } = createClient();
      const err = networkError('ECONNABORTED');
      mocks.mockGenerateText.mockRejectedValue(err);

      await expect(
        client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 }),
      ).rejects.toBe(err);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('APICallError isRetryable=true（无状态码）：可降级', async () => {
      const { client } = createClient();
      mocks.mockGenerateText
        .mockRejectedValueOnce(apiError(undefined, { isRetryable: true }))
        .mockResolvedValueOnce({ text: 'ok', usage: {} });

      await client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 });

      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
    });

    it('APICallError isRetryable=false（无状态码）：不降级', async () => {
      const { client } = createClient();
      const err = apiError(undefined, { isRetryable: false });
      mocks.mockGenerateText.mockRejectedValue(err);

      await expect(
        client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 }),
      ).rejects.toBe(err);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('显式模型 + 401：不降级（凭据错误换模型无意义）', async () => {
      const { client } = createClient();
      const err = apiError(401);
      mocks.mockGenerateText.mockRejectedValue(err);

      await expect(
        client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 }),
      ).rejects.toBe(err);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('显式模型 + 429：不降级（限流非供应商故障）', async () => {
      const { client } = createClient();
      const err = apiError(429);
      mocks.mockGenerateText.mockRejectedValue(err);

      await expect(
        client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 }),
      ).rejects.toBe(err);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('未传模型 + 5xx：不降级（默认模型降级无意义）', async () => {
      const { client } = createClient();
      const err = apiError(500);
      mocks.mockGenerateText.mockRejectedValue(err);

      await expect(client.generateText({ prompt: 'hi', maxAttempts: 1 })).rejects.toBe(err);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('显式传默认模型 id + 5xx：不降级（已是默认模型）', async () => {
      const { client } = createClient();
      const err = apiError(500);
      mocks.mockGenerateText.mockRejectedValue(err);

      await expect(
        client.generateText({ model: 'deepseek-v4-flash', prompt: 'hi', maxAttempts: 1 }),
      ).rejects.toBe(err);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(1);
    });

    it('降级后仍失败：抛降级模型的错误', async () => {
      const { client } = createClient();
      const err = apiError(500);
      const err2 = apiError(503);
      mocks.mockGenerateText.mockRejectedValueOnce(err).mockRejectedValueOnce(err2);

      await expect(
        client.generateText({ model: 'gpt-4o', prompt: 'hi', maxAttempts: 1 }),
      ).rejects.toBe(err2);
      expect(mocks.mockGenerateText).toHaveBeenCalledTimes(2);
    });
  });

  describe('getModel 显式覆盖透传', () => {
    it('运行时快照仅 apiKey：工厂只收 apiKey 覆盖', async () => {
      const { client, registry, createProviderFactory } = createClient();
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'only-key'),
        providerKind: 'openai',
        modelId: 'only-key',
        apiKey: 'sk-1',
        createdAt: 1_700_000_000_000,
      });

      await client.getModel('only-key');

      expect(createProviderFactory).toHaveBeenCalledWith('openai', { apiKey: 'sk-1' });
    });

    it('运行时快照仅 baseUrl：工厂只收 baseUrl 覆盖', async () => {
      const { client, registry, createProviderFactory } = createClient();
      registry.registerRuntimeModel({
        id: buildRuntimeSnapshotId('openai', 'only-base'),
        providerKind: 'openai',
        modelId: 'only-base',
        baseUrl: 'https://custom.api.com',
        createdAt: 1_700_000_000_000,
      });

      await client.getModel('only-base');

      expect(createProviderFactory).toHaveBeenCalledWith('openai', {
        baseUrl: 'https://custom.api.com',
      });
    });
  });

  describe('参数展开与 usage 映射', () => {
    it('system 传入：generateText 收到 system 参数', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });

      await client.generateText({ prompt: 'hi', system: '你是助手' });

      const args = mocks.mockGenerateText.mock.calls[0]?.[0] as { system?: string } | undefined;
      expect(args?.system).toBe('你是助手');
    });

    it('usage 部分字段：仅 totalTokens 时条件展开', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: { totalTokens: 42 } });

      const result = await client.generateText({ prompt: 'hi' });

      expect(result.usage).toEqual({ totalTokens: 42 });
    });

    it('signal 传入：generateText 收到 abortSignal', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ text: 'ok', usage: {} });
      const ac = new AbortController();

      await client.generateText({ prompt: 'hi', signal: ac.signal });

      const args = mocks.mockGenerateText.mock.calls[0]?.[0] as
        | { abortSignal?: AbortSignal }
        | undefined;
      expect(args?.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('generateJson system 传入：generateText 收到 system', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ output: { ok: true } });

      await client.generateJson({
        schema: z.object({ ok: z.boolean() }),
        prompt: 'hi',
        system: 'sys',
      });

      const args = mocks.mockGenerateText.mock.calls[0]?.[0] as { system?: string } | undefined;
      expect(args?.system).toBe('sys');
    });

    it('generateJson signal 传入：generateText 收到 abortSignal', async () => {
      const { client } = createClient();
      mocks.mockGenerateText.mockResolvedValue({ output: { ok: true } });
      const ac = new AbortController();

      await client.generateJson({
        schema: z.object({ ok: z.boolean() }),
        prompt: 'hi',
        signal: ac.signal,
      });

      const args = mocks.mockGenerateText.mock.calls[0]?.[0] as
        | { abortSignal?: AbortSignal }
        | undefined;
      expect(args?.abortSignal).toBeInstanceOf(AbortSignal);
    });
  });

  describe('超时信号接入与遥测', () => {
    it('重试触发遥测：logger.warn side query 重试', async () => {
      vi.useFakeTimers();
      try {
        const { client } = createClient();
        mocks.mockGenerateText
          .mockRejectedValueOnce(apiError(429))
          .mockResolvedValueOnce({ text: 'ok', usage: {} });

        const promise = client.generateText({ prompt: 'hi', maxAttempts: 3 });
        await vi.advanceTimersByTimeAsync(5000);

        await expect(promise).resolves.toMatchObject({ text: 'ok' });
        expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
          expect.objectContaining({ attempt: 1, errorStatus: 429 }),
          expect.stringContaining('side query 重试'),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('模型自带 timeoutMs：超时信号触发后中断重试（不无限重试）', async () => {
      vi.useFakeTimers();
      try {
        const registry = new ModelRegistry({
          entries: BUILTIN_MODELS.map((entry) =>
            entry.id === 'deepseek-v4-flash'
              ? { ...entry, generationConfig: { timeoutMs: 50 } }
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
        mocks.mockGenerateText.mockRejectedValue(apiError(429));

        const promise = client.generateText({ prompt: 'hi' });
        const assertion = expect(promise).rejects.toBeInstanceOf(APICallError);
        await vi.advanceTimersByTimeAsync(200);

        await assertion;
        // 超时中断：sleep 被 abort 打断立即重试一次，随后 signal.aborted 检查抛（不再退避重试）
        expect(mocks.mockGenerateText.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('defaultTimeoutMs 兜底：模型未配置超时时用全局默认', async () => {
      vi.useFakeTimers();
      try {
        const { registry, createProviderFactory } = createClient();
        const clientWithDefault = new LlmClient({
          modelRegistry: registry,
          createProviderFactory,
          defaultTimeoutMs: 50,
        });
        mocks.mockGenerateText.mockRejectedValue(apiError(429));

        const promise = clientWithDefault.generateText({ prompt: 'hi' });
        const assertion = expect(promise).rejects.toBeInstanceOf(APICallError);
        await vi.advanceTimersByTimeAsync(200);

        await assertion;
        expect(mocks.mockGenerateText.mock.calls.length).toBeLessThanOrEqual(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
