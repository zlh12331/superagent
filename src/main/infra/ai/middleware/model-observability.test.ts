// src/main/infra/ai/middleware/model-observability.test.ts
// 模型观测中间件单测：通过真实 wrapLanguageModel 驱动，验证打点语义
//
// 测试要点：
// 1. wrapGenerate 成功：debug 打点（provider/modelId/latencyMs/token 用量），result 透传
// 2. wrapGenerate 失败：warn 打点 + 原始错误原样抛出（不吞错）
// 3. wrapStream 成功：debug 打点，result 透传
// 4. wrapStream 失败：warn 打点 + 原始错误原样抛出
// 5. 不改参：doGenerate/doStream 收到原样 params（观测语义零侵入）

import { wrapLanguageModel } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 类型派生自 wrapLanguageModel 签名，避免直连传递依赖 @ai-sdk/provider：
// - 模型参数类型（LanguageModelV2|V3|V4）
// - doGenerate 调用参数类型（LanguageModelV4CallOptions）
type WrapModel = Parameters<typeof wrapLanguageModel>[0]['model'];
type WrapCallParams = Parameters<ReturnType<typeof wrapLanguageModel>['doGenerate']>[0];

// logger mock：避免触发真实 electron-log 初始化
const mocks = vi.hoisted(() => ({
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));
vi.mock('../../../utils/logger', () => ({ logger: mocks.mockLogger }));

import { modelObservabilityMiddleware } from './model-observability';

/** 可追踪的 fake v4 model：记录收到的 params，可按需注入生成/流式失败 */
function createFakeModel(options?: { failGenerate?: boolean; failStream?: boolean }) {
  const receivedGenerateParams: unknown[] = [];
  const receivedStreamParams: unknown[] = [];
  const model = {
    specificationVersion: 'v4',
    provider: 'deepseek',
    modelId: 'deepseek-chat',
    supportedUrls: undefined,
    doGenerate: async (params: unknown) => {
      receivedGenerateParams.push(params);
      if (options?.failGenerate) {
        throw new Error('generate boom');
      }
      return { text: 'ok', usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } };
    },
    doStream: async (params: unknown) => {
      receivedStreamParams.push(params);
      if (options?.failStream) {
        throw new Error('stream boom');
      }
      return { stream: {} };
    },
  } as unknown as WrapModel;
  return { model, receivedGenerateParams, receivedStreamParams };
}

const params = { prompt: 'hi' } as unknown as WrapCallParams;

describe('modelObservabilityMiddleware', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('wrapGenerate', () => {
    it('成功：debug 打点包含 provider/modelId/耗时/token 用量，result 原样透传', async () => {
      const { model } = createFakeModel();
      const wrapped = wrapLanguageModel({
        model,
        middleware: modelObservabilityMiddleware,
      });

      const result = await wrapped.doGenerate(params);

      expect(result).toMatchObject({ text: 'ok' });
      expect(mocks.mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'deepseek',
          modelId: 'deepseek-chat',
          latencyMs: expect.any(Number),
          inputTokens: 3,
          outputTokens: 5,
        }),
        '模型生成调用完成',
      );
    });

    it('失败：warn 打点并原样抛出原始错误（不吞错）', async () => {
      const { model } = createFakeModel({ failGenerate: true });
      const wrapped = wrapLanguageModel({
        model,
        middleware: modelObservabilityMiddleware,
      });

      await expect(wrapped.doGenerate(params)).rejects.toThrow('generate boom');
      expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'deepseek',
          modelId: 'deepseek-chat',
          latencyMs: expect.any(Number),
          error: 'generate boom',
        }),
        '模型生成调用失败',
      );
      // 失败不打成功日志
      expect(mocks.mockLogger.debug).not.toHaveBeenCalledWith(
        expect.anything(),
        '模型生成调用完成',
      );
    });
  });

  describe('wrapStream', () => {
    it('成功：debug 打点（TTFB 语义），result 原样透传', async () => {
      const { model } = createFakeModel();
      const wrapped = wrapLanguageModel({
        model,
        middleware: modelObservabilityMiddleware,
      });

      const result = await wrapped.doStream(params);

      expect(result).toMatchObject({ stream: {} });
      expect(mocks.mockLogger.debug).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'deepseek',
          modelId: 'deepseek-chat',
          latencyMs: expect.any(Number),
        }),
        '模型流式调用已建立',
      );
    });

    it('失败：warn 打点并原样抛出原始错误', async () => {
      const { model } = createFakeModel({ failStream: true });
      const wrapped = wrapLanguageModel({
        model,
        middleware: modelObservabilityMiddleware,
      });

      await expect(wrapped.doStream(params)).rejects.toThrow('stream boom');
      expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'stream boom' }),
        '模型流式调用启动失败',
      );
    });
  });

  it('观测不改参：doGenerate/doStream 收到原样 params', async () => {
    const { model, receivedGenerateParams, receivedStreamParams } = createFakeModel();
    const wrapped = wrapLanguageModel({
      model,
      middleware: modelObservabilityMiddleware,
    });

    await wrapped.doGenerate(params);
    await wrapped.doStream(params);

    expect(receivedGenerateParams[0]).toBe(params);
    expect(receivedStreamParams[0]).toBe(params);
  });
});
