// src/main/__tests__/embedding-client.test.ts
// embedding-client 单测
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpenAIConstructor, mockInstance } = vi.hoisted(() => {
  const mockInstance = {
    embeddings: {
      create: vi.fn().mockResolvedValue({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        // prompt_tokens / total_tokens 是 OpenAI API 真实返回字段名（snake_case）
        usage: {
          // biome-ignore lint/style/useNamingConvention: OpenAI API 返回字段名
          prompt_tokens: 10,
          // biome-ignore lint/style/useNamingConvention: OpenAI API 返回字段名
          total_tokens: 10,
        },
      }),
    },
  };
  // 注意：必须用普通 function 表达式而非箭头函数
  // Vitest 4 的 vi.fn 在 new 调用时会通过 [[Construct]] 内部方法调用 implementation，
  // 箭头函数没有 [[Construct]]，会导致 `() => mockInstance is not a constructor` 报错。
  // OpenAI SDK 通过 `new OpenAI(...)` 实例化，因此 mock 实现必须是可构造的普通函数。
  // biome-ignore lint/complexity/useArrowFunction: vi.fn 箭头函数实现不支持 new 调用，必须用 function 表达式
  // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
  const mockOpenAIConstructor = vi.fn(function () {
    return mockInstance;
  });
  // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
  return { mockOpenAIConstructor, mockInstance };
});

// mock openai SDK
vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
}));

// mock config（避免触发真实 env 读取）
vi.mock('../config', () => ({
  getAppConfig: () => ({
    ollama: {
      url: 'http://localhost:11434',
      embedModel: 'nemotron-3-embed-1b-bf16',
      embedDimensions: 2048,
    },
  }),
}));

import { embed, getEmbeddingClient, resetEmbeddingClient } from '../infra/ai/embedding-client';

describe('embedding-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEmbeddingClient();
  });

  it('首次调用创建指向 Ollama 的 OpenAI 实例', () => {
    const client = getEmbeddingClient();

    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
      baseURL: 'http://localhost:11434/v1',
      apiKey: 'ollama',
      maxRetries: 0,
    });
    expect(client).toBe(mockInstance);
  });

  it('后续调用返回缓存的实例', () => {
    const client1 = getEmbeddingClient();
    const client2 = getEmbeddingClient();

    expect(client1).toBe(client2);
    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(1);
  });

  it('resetEmbeddingClient 后重新创建实例', () => {
    getEmbeddingClient();
    resetEmbeddingClient();
    getEmbeddingClient();

    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(2);
  });

  it('embed 调用 SDK 生成嵌入向量', async () => {
    const vectors = await embed(['你好', '世界']);

    expect(mockInstance.embeddings.create).toHaveBeenCalledWith({
      model: 'nemotron-3-embed-1b-bf16',
      input: ['你好', '世界'],
    });
    expect(vectors).toEqual([[0.1, 0.2, 0.3]]);
  });

  it('embed 空数组时不调用 SDK', async () => {
    const vectors = await embed([]);

    expect(mockInstance.embeddings.create).not.toHaveBeenCalled();
    expect(vectors).toEqual([]);
  });
});
