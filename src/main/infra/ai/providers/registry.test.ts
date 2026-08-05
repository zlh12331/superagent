// src/main/infra/ai/providers/registry.test.ts
// ProviderRegistry deepseek 工厂单测：DeepSeek 官方文档深度适配
//
// 测试要点：
// 1. transformRequestBody：思考模式显式开启（thinking: enabled）
// 2. transformRequestBody：已有 thinking 配置时不覆盖
// 3. convertUsage：DeepSeek 非标准字段（prompt_cache_hit_tokens /
//    prompt_cache_miss_tokens）映射为 cacheRead / noCache
// 4. convertUsage：兼容标准 OpenAI 字段（prompt_tokens_details.cached_tokens）
// 5. convertUsage：reasoning_tokens 映射

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from './registry';

const mocks = vi.hoisted(() => {
  // provider 工厂 mock（createOpenAICompatible 返回值）
  const mockProviderFactory = vi.fn();
  // createOpenAICompatible mock（deepseek / ollama 走该协议）
  const mockCreateOpenAICompatible = vi.fn(() => mockProviderFactory);
  // electron app mock（config 依赖 app.isPackaged）
  const mockApp = {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  };
  // logger mock
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    mockProviderFactory,
    mockCreateOpenAICompatible,
    mockApp,
    mockLogger,
  };
});

// mock @ai-sdk/openai-compatible：拦截 createOpenAICompatible 调用
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.mockCreateOpenAICompatible,
}));

// mock electron：config 依赖 app.isPackaged（registry 从 config.providers 读取 baseURL）
vi.mock('electron', () => ({ app: mocks.mockApp }));

// mock logger：避免触发真实 electron-log 初始化
vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

/** 获取 deepseek 工厂的 createOpenAICompatible 配置 */
function getDeepSeekOptions(): Record<string, unknown> {
  const registry = new ProviderRegistry();
  registry.createFactory('deepseek', { apiKey: 'sk-test' });
  // mock 调用参数元组为空（vi.fn 无参类型），需显式 cast 后访问
  const calls = mocks.mockCreateOpenAICompatible.mock.calls as unknown[][];
  const options = calls[0]?.[0];
  if (options === undefined) {
    throw new Error('createOpenAICompatible 未被调用');
  }
  return options as Record<string, unknown>;
}

/** 获取 transformRequestBody 函数 */
function getTransform(): (args: Record<string, unknown>) => Record<string, unknown> {
  const transform = getDeepSeekOptions()['transformRequestBody'] as
    | ((args: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  if (transform === undefined) {
    throw new Error('transformRequestBody 未配置');
  }
  return transform;
}

/** 获取 convertUsage 函数 */
function getConvertUsage(): (usage: Record<string, unknown>) => {
  inputTokens: Record<string, unknown>;
  outputTokens: Record<string, unknown>;
} {
  const convert = getDeepSeekOptions()['convertUsage'] as
    | ((usage: Record<string, unknown>) => {
        inputTokens: Record<string, unknown>;
        outputTokens: Record<string, unknown>;
      })
    | undefined;
  if (convert === undefined) {
    throw new Error('convertUsage 未配置');
  }
  return convert;
}

describe('deepseek 工厂（DeepSeek 官方适配）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('transformRequestBody（思考模式）', () => {
    it('自动注入 thinking: enabled（思考模式显式开启）', () => {
      const transform = getTransform();

      const body = transform({ model: 'deepseek-v4-pro', messages: [] });

      expect(body['thinking']).toEqual({ type: 'enabled' });
      // 其余字段原样保留
      expect(body['model']).toBe('deepseek-v4-pro');
      expect(body['messages']).toEqual([]);
    });

    it('已有 thinking 配置时不覆盖（尊重调用方显式关闭）', () => {
      const transform = getTransform();

      const body = transform({ thinking: { type: 'disabled' } });

      expect(body['thinking']).toEqual({ type: 'disabled' });
    });
  });

  describe('convertUsage（KV cache 计费适配）', () => {
    it('DeepSeek 非标准字段：prompt_cache_hit_tokens → cacheRead', () => {
      const convert = getConvertUsage();

      const usage = convert({
        // snake_case 字段名来自 OpenAI/DeepSeek API 响应：计算属性规避命名规范
        ['prompt_tokens']: 100,
        ['completion_tokens']: 50,
        ['total_tokens']: 150,
        ['prompt_cache_hit_tokens']: 30,
        ['prompt_cache_miss_tokens']: 70,
        ['completion_tokens_details']: { ['reasoning_tokens']: 20 },
      });

      expect(usage['inputTokens']).toEqual({
        total: 100,
        noCache: 70,
        cacheRead: 30,
        cacheWrite: 0,
      });
      expect(usage['outputTokens']).toEqual({ total: 50, text: undefined, reasoning: 20 });
    });

    it('兼容标准 OpenAI 字段：prompt_tokens_details.cached_tokens', () => {
      const convert = getConvertUsage();

      const usage = convert({
        ['prompt_tokens']: 100,
        ['completion_tokens']: 50,
        ['prompt_tokens_details']: { ['cached_tokens']: 40 },
      });

      expect(usage['inputTokens']).toEqual({
        total: 100,
        noCache: 60,
        cacheRead: 40,
        cacheWrite: 0,
      });
    });

    it('无缓存信息：noCache = total，cacheRead = 0', () => {
      const convert = getConvertUsage();

      const usage = convert({ ['prompt_tokens']: 80, ['completion_tokens']: 30 });

      expect(usage['inputTokens']).toEqual({ total: 80, noCache: 80, cacheRead: 0, cacheWrite: 0 });
    });
  });
});
