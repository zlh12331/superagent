import { AppError, ErrorCode } from '@code-agent/shared/main';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const mockProviderFactory = vi.fn((modelId: string) => ({
    specificationVersion: 'v4',
    provider: 'test-provider',
    modelId,
    doGenerate: async () => ({ text: 'mock' }),
    doStream: async () => ({ stream: {} }),
  }));
  const mockCreateOpenAICompatible = vi.fn(() => mockProviderFactory);
  const mockCreateOpenAI = vi.fn(() => mockProviderFactory);
  const mockCreateAnthropic = vi.fn(() => mockProviderFactory);
  const mockGetSecret = vi.fn();
  const mockListRuntimeModels = vi.fn(
    async (): Promise<Array<Record<string, unknown>>> => [
      { modelId: 'deepseek-chat', providerKind: 'deepseek', isEnabled: true },
    ],
  );
  const mockApp = {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  };
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    mockProviderFactory,
    mockCreateOpenAICompatible,
    mockCreateOpenAI,
    mockCreateAnthropic,
    mockGetSecret,
    mockListRuntimeModels,
    mockApp,
    mockLogger,
  };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.mockCreateOpenAICompatible,
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: mocks.mockCreateOpenAI,
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: mocks.mockCreateAnthropic,
}));

vi.mock('../../storage/keychain', () => ({
  getSecret: mocks.mockGetSecret,
}));

vi.mock('electron', () => ({ app: mocks.mockApp }));

vi.mock('../../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

import { ProviderRegistry } from '../providers';
import {
  getAIProvider,
  getModel,
  getProviderCacheSize,
  resetAIProvider,
  runtimeModelStore,
} from './ai-provider';

describe('ai-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAIProvider();
    mocks.mockGetSecret.mockResolvedValue('sk-test-api-key');
    vi.spyOn(runtimeModelStore, 'list').mockResolvedValue([
      { modelId: 'deepseek-chat', providerKind: 'deepseek', isEnabled: true } as never,
    ]);
  });

  describe('getAIProvider（默认 deepseek）', () => {
    it('首次调用：从 keychain 读取 apiKey 并创建 provider', async () => {
      const provider = await getAIProvider();

      expect(mocks.mockGetSecret).toHaveBeenCalledWith('deepseek-api-key');
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
      expect(provider).toBe(mocks.mockProviderFactory);
    });

    it('缓存：第二次调用直接返回缓存，不重复读 keychain', async () => {
      await getAIProvider();
      await getAIProvider();

      expect(mocks.mockGetSecret).toHaveBeenCalledTimes(1);
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
    });

    it('显式 apiKey 参数：创建临时实例不污染缓存', async () => {
      const cached = await getAIProvider();
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);

      const tempProvider = await getAIProvider({ apiKey: 'sk-explicit-key' });

      expect(mocks.mockGetSecret).toHaveBeenCalledTimes(1);
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
      void tempProvider;

      const cachedAgain = await getAIProvider();
      expect(cachedAgain).toBe(cached);
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
    });

    it('createOpenAICompatible 入参：baseURL 应拼接 /v1 后缀', async () => {
      await getAIProvider();

      type ProviderConfig = {
        name: string;
        baseURL: string;
        apiKey: string;
        includeUsage: boolean;
      };
      const calls = mocks.mockCreateOpenAICompatible.mock.calls as unknown as [ProviderConfig][];
      const config = calls[0]?.[0];
      if (!config) {
        throw new Error('createOpenAICompatible 未被调用或入参缺失');
      }
      expect(config.name).toBe('deepseek');
      expect(config.baseURL).toBe('https://api.deepseek.com/v1');
      expect(config.apiKey).toBe('sk-test-api-key');
      expect(config.includeUsage).toBe(true);
    });

    it('keychain 返回 null：抛 AppError(AI_API_KEY_MISSING)', async () => {
      mocks.mockGetSecret.mockResolvedValue(null);

      await expect(getAIProvider()).rejects.toThrow(AppError);
      await expect(getAIProvider()).rejects.toMatchObject({
        code: ErrorCode.AI_API_KEY_MISSING,
      });
    });

    it('keychain 返回 null：不调用 createOpenAICompatible', async () => {
      mocks.mockGetSecret.mockResolvedValue(null);

      await expect(getAIProvider()).rejects.toThrow();
      expect(mocks.mockCreateOpenAICompatible).not.toHaveBeenCalled();
    });
  });

  describe('多供应商路由', () => {
    it('kind=openai：使用 createOpenAI 并读取 openai-api-key', async () => {
      await getAIProvider({ kind: 'openai' });

      expect(mocks.mockGetSecret).toHaveBeenCalledWith('openai-api-key');
      expect(mocks.mockCreateOpenAI).toHaveBeenCalledTimes(1);
      expect(mocks.mockCreateOpenAICompatible).not.toHaveBeenCalled();
    });

    it('kind=anthropic：使用 createAnthropic 并读取 anthropic-api-key', async () => {
      await getAIProvider({ kind: 'anthropic' });

      expect(mocks.mockGetSecret).toHaveBeenCalledWith('anthropic-api-key');
      expect(mocks.mockCreateAnthropic).toHaveBeenCalledTimes(1);
      expect(mocks.mockCreateOpenAICompatible).not.toHaveBeenCalled();
    });

    it('kind=ollama：无需 API Key，走 OpenAI Compatible 协议', async () => {
      await getAIProvider({ kind: 'ollama' });

      expect(mocks.mockGetSecret).not.toHaveBeenCalled();
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
    });

    it('未知供应商：抛错', async () => {
      // @ts-expect-error 故意传入非法 kind 验证运行时校验
      await expect(getAIProvider({ kind: 'unknown-provider' })).rejects.toThrow(/未知模型供应商/);
    });

    it('不同供应商缓存相互独立', async () => {
      await getAIProvider({ kind: 'deepseek' });
      await getAIProvider({ kind: 'openai' });

      expect(getProviderCacheSize()).toBe(2);
    });
  });

  describe('getModel', () => {
    it('默认 modelId：使用供应商默认模型（deepseek-v4-flash）', async () => {
      const providerFactory = (await getAIProvider()) as unknown as Mock;
      providerFactory.mockClear();

      const model = await getModel();

      expect(providerFactory).toHaveBeenCalledWith('deepseek-v4-flash');
      expect(model).toMatchObject({
        specificationVersion: 'v4',
        provider: 'test-provider',
        modelId: 'deepseek-v4-flash',
      });
    });

    it('显式 modelId：覆盖默认值', async () => {
      const providerFactory = (await getAIProvider()) as unknown as Mock;
      providerFactory.mockClear();

      await getModel('deepseek-reasoner');

      expect(providerFactory).toHaveBeenCalledWith('deepseek-reasoner');
    });

    it('未配置任何启用模型：门禁拒绝（AI_MODEL_NOT_CONFIGURED，不创建 provider）', async () => {
      (runtimeModelStore.list as unknown as Mock).mockResolvedValueOnce([]);
      const providerFactory = (await getAIProvider()) as unknown as Mock;
      providerFactory.mockClear();

      await expect(getModel()).rejects.toMatchObject({
        code: ErrorCode.AI_MODEL_NOT_CONFIGURED,
      });
      expect(providerFactory).not.toHaveBeenCalled();
    });

    it('显式 kind + modelId：路由到对应供应商并覆盖模型', async () => {
      const providerFactory = (await getAIProvider({ kind: 'anthropic' })) as unknown as Mock;
      providerFactory.mockClear();

      await getModel('claude-opus-4-20250514', { kind: 'anthropic' });

      expect(providerFactory).toHaveBeenCalledWith('claude-opus-4-20250514');
    });

    it('显式 apiKey：创建临时 provider 不污染缓存', async () => {
      await getAIProvider();
      mocks.mockProviderFactory.mockClear();
      mocks.mockCreateOpenAICompatible.mockClear();

      await getModel('test-model', { apiKey: 'sk-temp' });

      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
      expect(mocks.mockProviderFactory).toHaveBeenCalledWith('test-model');
    });
  });

  describe('ProviderRegistry', () => {
    it('内置 10 个供应商，默认 kind 为 deepseek', () => {
      const registry = new ProviderRegistry();
      const infos = registry.list();

      expect(infos).toHaveLength(10);
      expect(registry.getDefaultKind()).toBe('deepseek');
      expect(infos.map((i) => i.kind).sort()).toEqual(
        [
          'anthropic',
          'deepseek',
          'ollama',
          'openai',
          'moonshot',
          'zhipu',
          'qwen',
          'doubao',
          'siliconflow',
          'openrouter',
        ].sort(),
      );
    });

    it('ProviderInfo：包含 kind / 默认模型 / 是否需要 API Key', () => {
      const registry = new ProviderRegistry();
      const deepseek = registry.list().find((i) => i.kind === 'deepseek');

      expect(deepseek).toMatchObject({
        kind: 'deepseek',
        defaultModel: 'deepseek-v4-flash',
        requiresApiKey: true,
        isDefault: true,
      });
    });

    it('ollama 不需要 API Key 且非默认', () => {
      const registry = new ProviderRegistry();
      const ollama = registry.list().find((i) => i.kind === 'ollama');

      expect(ollama).toMatchObject({
        requiresApiKey: false,
        isDefault: false,
      });
    });

    it('未知 kind 获取定义：抛错', () => {
      const registry = new ProviderRegistry();
      // @ts-expect-error 故意传入非法 kind 验证运行时校验
      expect(() => registry.getDefinition('unknown')).toThrow(/未知模型供应商/);
    });
  });

  describe('resetAIProvider', () => {
    it('清空缓存后下次调用会重新创建 provider', async () => {
      await getAIProvider();
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);

      resetAIProvider();

      await getAIProvider();
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
      expect(mocks.mockGetSecret).toHaveBeenCalledTimes(2);
    });

    it('多次调用幂等（安全）', async () => {
      resetAIProvider();
      resetAIProvider();
      resetAIProvider();

      await expect(getAIProvider()).resolves.toBeDefined();
    });
  });
});
