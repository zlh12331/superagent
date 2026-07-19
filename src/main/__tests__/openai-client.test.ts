// src/main/__tests__/openai-client.test.ts
// openai-client 单测
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpenAIConstructor, mockInstance, mockKeychain } = vi.hoisted(() => {
  const mockInstance = {
    chat: { completions: { create: vi.fn() } },
    embeddings: { create: vi.fn() },
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
  const mockKeychain = {
    getSecret: vi.fn(),
    setSecret: vi.fn(),
    deleteSecret: vi.fn(),
    listSecrets: vi.fn(),
  };
  // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
  return { mockOpenAIConstructor, mockInstance, mockKeychain };
});

// mock openai SDK
vi.mock('openai', () => ({
  default: mockOpenAIConstructor,
}));

// mock keychain
vi.mock('../infra/storage/keychain', () => ({
  getSecret: mockKeychain.getSecret,
  setSecret: mockKeychain.setSecret,
  deleteSecret: mockKeychain.deleteSecret,
  listSecrets: mockKeychain.listSecrets,
}));

// mock config（避免触发真实 env 读取）
vi.mock('../config', () => ({
  getAppConfig: () => ({
    deepseek: {
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      timeout: 60_000,
    },
  }),
}));

import { ErrorCode } from '@novel-writer/shared';
import { getOpenAIClient, resetOpenAIClient } from '../infra/ai/openai-client';

describe('openai-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOpenAIClient();
    mockKeychain.getSecret.mockResolvedValue('sk-test-api-key');
  });

  it('首次调用创建 OpenAI 实例', async () => {
    const client = await getOpenAIClient();

    expect(mockKeychain.getSecret).toHaveBeenCalledWith('deepseek-api-key');
    expect(mockOpenAIConstructor).toHaveBeenCalledWith({
      // biome-ignore lint/style/useNamingConvention: baseURL 是 OpenAI SDK 官方字段名
      baseURL: 'https://api.deepseek.com',
      apiKey: 'sk-test-api-key',
      timeout: 60_000,
      maxRetries: 0,
    });
    expect(client).toBe(mockInstance);
  });

  it('后续调用返回缓存的实例', async () => {
    const client1 = await getOpenAIClient();
    const client2 = await getOpenAIClient();

    expect(client1).toBe(client2);
    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(1);
  });

  it('resetOpenAIClient 后下次调用重新创建实例', async () => {
    await getOpenAIClient();
    resetOpenAIClient();
    await getOpenAIClient();

    expect(mockOpenAIConstructor).toHaveBeenCalledTimes(2);
  });

  it('API Key 未配置时抛 AI_API_KEY_MISSING', async () => {
    mockKeychain.getSecret.mockResolvedValue(null);

    await expect(getOpenAIClient()).rejects.toMatchObject({
      code: ErrorCode.AI_API_KEY_MISSING,
    });
  });

  it('使用传入的 apiKey 覆盖 keychain', async () => {
    await getOpenAIClient({ apiKey: 'sk-custom-key' });

    expect(mockKeychain.getSecret).not.toHaveBeenCalled();
    expect(mockOpenAIConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'sk-custom-key' }),
    );
  });
});
