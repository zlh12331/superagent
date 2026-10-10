import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderName, ProviderRegistry, toKeychainKey } from './registry';

const mocks = vi.hoisted(() => {
  const mockProviderFactory = vi.fn();
  const mockCreateOpenAICompatible = vi.fn(() => mockProviderFactory);
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
    mockApp,
    mockLogger,
  };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.mockCreateOpenAICompatible,
}));

vi.mock('electron', () => ({ app: mocks.mockApp }));

vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

function getDeepSeekOptions(): Record<string, unknown> {
  const registry = new ProviderRegistry();
  registry.createFactory('deepseek', { apiKey: 'sk-test' });
  const calls = mocks.mockCreateOpenAICompatible.mock.calls as unknown[][];
  const options = calls[0]?.[0];
  if (options === undefined) {
    throw new Error('createOpenAICompatible 未被调用');
  }
  return options as Record<string, unknown>;
}

function getTransform(): (args: Record<string, unknown>) => Record<string, unknown> {
  const transform = getDeepSeekOptions()['transformRequestBody'] as
    | ((args: Record<string, unknown>) => Record<string, unknown>)
    | undefined;
  if (transform === undefined) {
    throw new Error('transformRequestBody 未配置');
  }
  return transform;
}

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

describe('ProviderRegistry 注册表（类行为三件套）', () => {
  it('正向：默认构造函数注册全部内置供应商（10 家）', () => {
    const registry = new ProviderRegistry();
    const infos = registry.list();
    expect(infos).toHaveLength(10);
    expect(infos.map((i) => i.kind)).toEqual(
      expect.arrayContaining([
        'deepseek',
        'openai',
        'anthropic',
        'ollama',
        'moonshot',
        'zhipu',
        'qwen',
        'doubao',
        'siliconflow',
        'openrouter',
      ]),
    );
  });

  it('正向：自定义 definitions 注册（含 isDefault 标记）', () => {
    const registry = new ProviderRegistry([
      {
        kind: 'deepseek',
        defaultModel: 'm1',
        requiresApiKey: true,
        isDefault: false,
      },
      {
        kind: 'openai',
        defaultModel: 'm2',
        requiresApiKey: true,
        isDefault: true,
      },
    ]);
    expect(registry.list()).toHaveLength(2);
    expect(registry.getDefaultKind()).toBe('openai');
  });

  it('异常：未知 kind 注册 → 构造抛错（工厂缺失）', () => {
    expect(() => {
      new ProviderRegistry([
        {
          kind: 'deepseek',
          defaultModel: 'm',
          requiresApiKey: true,
          isDefault: false,
        },
        {
          kind: 'nonexistent' as never,
          defaultModel: 'm',
          requiresApiKey: true,
          isDefault: false,
        },
      ]);
    }).toThrow('未注册供应商工厂');
  });

  it('getDefinition 正向：返回已注册定义', () => {
    const registry = new ProviderRegistry();
    expect(registry.getDefinition('deepseek').requiresApiKey).toBe(true);
  });

  it('getDefinition 异常：未知 kind 抛错', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getDefinition('nonexistent' as never)).toThrow('未知模型供应商');
  });

  it('getDefaultKind：无 isDefault 标记时回落第一个注册', () => {
    const registry = new ProviderRegistry([
      {
        kind: 'deepseek',
        defaultModel: 'm',
        requiresApiKey: true,
        isDefault: false,
      },
      {
        kind: 'openai',
        defaultModel: 'm',
        requiresApiKey: true,
        isDefault: false,
      },
    ]);
    expect(registry.getDefaultKind()).toBe('deepseek');
  });

  it('getDefaultKind 异常：空注册表抛错', () => {
    const registry = new ProviderRegistry([]);
    expect(() => registry.getDefaultKind()).toThrow('注册表为空');
  });

  it('createFactory 正向：返回工厂函数且可实例化', () => {
    const registry = new ProviderRegistry();
    const factory = registry.createFactory('ollama', { apiKey: undefined });
    expect(typeof factory).toBe('function');
  });

  it('createFactory 异常：未知 kind 抛错', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.createFactory('nonexistent' as never, { apiKey: undefined })).toThrow(
      '未知模型供应商',
    );
  });

  it('list：isDefault 标记与定义一致', () => {
    const registry = new ProviderRegistry([
      {
        kind: 'deepseek',
        defaultModel: 'm',
        requiresApiKey: false,
        isDefault: true,
      },
      {
        kind: 'openai',
        defaultModel: 'm',
        requiresApiKey: true,
        isDefault: false,
      },
    ]);
    const infos = registry.list();
    expect(infos.find((i) => i.kind === 'deepseek')?.isDefault).toBe(true);
    expect(infos.find((i) => i.kind === 'openai')?.isDefault).toBe(false);
  });
});

describe('provider 纯函数', () => {
  it('toKeychainKey：按 kind 生成 keychain key 前缀', () => {
    expect(toKeychainKey('deepseek')).toBe('deepseek-api-key');
    expect(toKeychainKey('ollama')).toBe('ollama-api-key');
  });

  it('getProviderName：返回 kind 原值（providerOptions 键约定收敛点）', () => {
    expect(getProviderName('deepseek')).toBe('deepseek');
    expect(getProviderName('anthropic')).toBe('anthropic');
  });
});
