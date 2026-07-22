// src/main/infra/ai/ai-provider.test.ts
// ai-provider 单测：@ai-sdk/openai-compatible 工厂 + keychain 读取 + 单例缓存
//
// 测试要点：
// 1. getAIProvider 首次调用从 keychain 读取 apiKey 并创建 provider
// 2. 缓存：第二次调用直接返回缓存（不重复读 keychain）
// 3. 显式 apiKey 参数：创建临时实例不污染缓存
// 4. keychain 返回 null：抛 AppError(AI_API_KEY_MISSING)
// 5. getModel：调用 provider 工厂返回 LanguageModel
// 6. resetAIProvider：清空缓存
// 7. createProvider 内部 baseURL 拼接 /v1

import { AppError, ErrorCode } from '@novel-writer/shared';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象（工厂内部直接 return，不能嵌套 const）
const mocks = vi.hoisted(() => {
  // provider 工厂 mock（createOpenAICompatible 返回值）
  const mockProviderFactory = vi.fn();
  // createOpenAICompatible mock
  const mockCreateOpenAICompatible = vi.fn(() => mockProviderFactory);
  // keychain.getSecret mock
  const mockGetSecret = vi.fn();
  // logger mock
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  // config 依赖 electron app.isPackaged
  const mockApp = {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  };
  // config.getAppConfig mock（避免 env 污染）
  const mockGetAppConfig = vi.fn(() => ({
    isDev: true,
    isPackaged: false,
    logLevel: 'info' as const,
    sentry: { dsn: '', tracesSampleRate: 0.1 },
    deepseek: {
      apiBase: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      timeout: 60_000,
    },
  }));
  const mockResetConfigCache = vi.fn();
  return {
    mockProviderFactory,
    mockCreateOpenAICompatible,
    mockGetSecret,
    mockLogger,
    mockApp,
    mockGetAppConfig,
    mockResetConfigCache,
  };
});

// mock @ai-sdk/openai-compatible：拦截 createOpenAICompatible 调用
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.mockCreateOpenAICompatible,
}));

// mock keychain：拦截 getSecret，避免真实文件 IO
vi.mock('../storage/keychain', () => ({
  getSecret: mocks.mockGetSecret,
}));

// mock logger：避免触发真实 electron-log 初始化
vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

// mock electron：config 依赖 app.isPackaged + app.getPath
vi.mock('electron', () => ({ app: mocks.mockApp }));

// mock config：直接返回固定配置，避免 env 污染
vi.mock('../../config', () => ({
  getAppConfig: mocks.mockGetAppConfig,
  resetConfigCache: mocks.mockResetConfigCache,
}));

import { getAIProvider, getModel, resetAIProvider } from './ai-provider';

describe('ai-provider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置单例缓存（避免用例之间污染）
    resetAIProvider();
    // 默认：keychain 中存在 API Key
    mocks.mockGetSecret.mockResolvedValue('sk-test-api-key');
  });

  describe('getAIProvider', () => {
    it('首次调用：从 keychain 读取 apiKey 并创建 provider', async () => {
      const provider = await getAIProvider();

      // 应该调用 keychain.getSecret('deepseek-api-key')
      expect(mocks.mockGetSecret).toHaveBeenCalledWith('deepseek-api-key');
      // 应该调用 createOpenAICompatible
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
      // 返回值应该是 provider 工厂函数
      expect(provider).toBe(mocks.mockProviderFactory);
    });

    it('缓存：第二次调用直接返回缓存，不重复读 keychain', async () => {
      await getAIProvider();
      await getAIProvider();

      // keychain 应该只被读一次
      expect(mocks.mockGetSecret).toHaveBeenCalledTimes(1);
      // createOpenAICompatible 应该只被调用一次
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
    });

    it('显式 apiKey 参数：创建临时实例不污染缓存', async () => {
      // 先初始化缓存
      const cached = await getAIProvider();
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);

      // 显式传入 apiKey：不应读 keychain，应创建新实例
      const tempProvider = await getAIProvider({ apiKey: 'sk-explicit-key' });

      // 不应再次读 keychain（因为显式传入了 apiKey）
      expect(mocks.mockGetSecret).toHaveBeenCalledTimes(1);
      // createOpenAICompatible 应该被调用 2 次（缓存 + 临时）
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
      // 临时实例不应等于缓存实例（mock 每次返回同一引用，需验证 createOpenAICompatible 调用次数）
      void tempProvider; // tempProvider 与 cached 都是 mockProviderFactory 引用，仅验证调用次数

      // 再次调用（无参数）：应返回原缓存实例
      const cachedAgain = await getAIProvider();
      expect(cachedAgain).toBe(cached);
      // createOpenAICompatible 调用次数不变（缓存命中）
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
    });

    it('createOpenAICompatible 入参：baseURL 应拼接 /v1 后缀', async () => {
      await getAIProvider();

      // 校验传给 createOpenAICompatible 的配置
      // mock.calls 类型推断为空元组 `[][]`，无法直接索引 [0][0]
      // 用 as unknown as 断言为 `[[ConfigShape]]` 以访问首个调用的首参
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
      // baseURL 应为 apiBase + /v1
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

  describe('getModel', () => {
    it('默认 modelId：使用 config.deepseek.model 并调用 provider 工厂', async () => {
      // getAIProvider 返回 mock 的 vi.fn()，但类型是 OpenAICompatibleProvider
      // 需要 cast 为 Mock 才能调用 mockClear
      const providerFactory = (await getAIProvider()) as unknown as Mock;
      // 清除之前的调用记录
      providerFactory.mockClear();

      const model = await getModel();

      // 应使用 config 中的默认 model id 调用 provider 工厂
      expect(providerFactory).toHaveBeenCalledWith('deepseek-v4-flash');
      // 返回值就是 provider 工厂的返回值
      expect(model).toBe(mocks.mockProviderFactory());
    });

    it('显式 modelId：覆盖默认值', async () => {
      const providerFactory = (await getAIProvider()) as unknown as Mock;
      providerFactory.mockClear();

      await getModel('deepseek-reasoner');

      expect(providerFactory).toHaveBeenCalledWith('deepseek-reasoner');
    });

    it('显式 apiKey：创建临时 provider 不污染缓存', async () => {
      // 先初始化缓存
      await getAIProvider();
      mocks.mockProviderFactory.mockClear();
      mocks.mockCreateOpenAICompatible.mockClear();

      // 显式 apiKey 调用 getModel
      await getModel('test-model', { apiKey: 'sk-temp' });

      // createOpenAICompatible 应该被调用（临时实例）
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
      // provider 工厂应该用 'test-model' 调用
      expect(mocks.mockProviderFactory).toHaveBeenCalledWith('test-model');
    });
  });

  describe('resetAIProvider', () => {
    it('清空缓存后下次调用会重新创建 provider', async () => {
      await getAIProvider();
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);

      resetAIProvider();

      await getAIProvider();
      // 应该重新创建一次 provider
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(2);
      // keychain 也应该被重新读一次
      expect(mocks.mockGetSecret).toHaveBeenCalledTimes(2);
    });

    it('多次调用幂等（安全）', async () => {
      // 多次 reset 不应抛错
      resetAIProvider();
      resetAIProvider();
      resetAIProvider();

      // 再次获取应正常工作
      await expect(getAIProvider()).resolves.toBeDefined();
    });
  });
});
