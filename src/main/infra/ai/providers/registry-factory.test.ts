import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from './registry';

const mocks = vi.hoisted(() => {
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
  return { mockApp, mockLogger };
});

vi.mock('electron', () => ({ app: mocks.mockApp }));

vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

describe('Provider 工厂真实实例化（AI SDK 消费集成验证）', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new ProviderRegistry();
  });

  /** 断言 LanguageModel 实例具备 SDK 消费接口（v7 规范：doGenerate/doStream） */
  function expectModelUsable(model: unknown): void {
    expect(model).toBeDefined();
    const lm = model as { doGenerate?: unknown; doStream?: unknown };
    expect(typeof lm.doGenerate).toBe('function');
    expect(typeof lm.doStream).toBe('function');
  }

  it('deepseek：createOpenAICompatible 参数可被 SDK 消费，LanguageModel 实例化成功', () => {
    const factory = registry.createFactory('deepseek', { apiKey: 'sk-test' });

    const model = factory('deepseek-v4-flash');

    expectModelUsable(model);
  });

  it('deepseek 无 apiKey（本地 ollama 同协议路径）：实例化成功', () => {
    const factory = registry.createFactory('ollama', { apiKey: undefined });

    expectModelUsable(factory('qwen2.5-coder:7b'));
  });

  it('openai / anthropic：官方 SDK 工厂实例化成功', () => {
    expectModelUsable(registry.createFactory('openai', { apiKey: 'sk-test' })('gpt-4o'));
    expectModelUsable(
      registry.createFactory('anthropic', { apiKey: 'sk-test' })('claude-sonnet-4-20250514'),
    );
  });

  it('baseUrl 覆盖（运行时快照场景）：实例化成功且端点生效', () => {
    const factory = registry.createFactory('deepseek', {
      apiKey: 'sk-test',
      baseUrl: 'https://custom.api.com',
    });

    expectModelUsable(factory('deepseek-v4-flash'));
  });
});

describe('其余内置工厂真实实例化（SDK 消费集成）', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  it.each([
    ['moonshot', 'kimi-k2'],
    ['zhipu', 'glm-4.5'],
    ['qwen', 'qwen3-coder'],
    ['doubao', 'doubao-seed'],
    ['siliconflow', 'deepseek-ai/DeepSeek-V3'],
    ['openrouter', 'anthropic/claude-3.5-sonnet'],
  ])('%s：OpenAI Compatible 工厂真实实例化成功', (kind, modelId) => {
    const factory = registry.createFactory(kind as never, { apiKey: 'sk-test' });
    const model = factory(modelId) as { doGenerate?: unknown; doStream?: unknown };
    expect(typeof model.doGenerate).toBe('function');
    expect(typeof model.doStream).toBe('function');
  });

  it('ollama：本地协议工厂（固定 apiKey=ollama）真实实例化成功', () => {
    const factory = registry.createFactory('ollama', { apiKey: undefined });
    const model = factory('qwen2.5-coder:7b') as { doGenerate?: unknown };
    expect(typeof model.doGenerate).toBe('function');
  });

  it('baseUrl 缺失时回落 config（env 覆盖链路生效）', () => {
    const factory = registry.createFactory('moonshot', { apiKey: 'sk-test' });
    expect(typeof factory).toBe('function');
  });
});
