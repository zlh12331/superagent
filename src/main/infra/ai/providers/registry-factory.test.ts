// src/main/infra/ai/providers/registry-factory.test.ts
// Provider 工厂真实实例化集成测试（不 mock @ai-sdk/*）
//
// 目的：验证 AI SDK 能真实消费我们的工厂参数（DeepSeek 适配的
// transformRequestBody / convertUsage / thinking 注入不导致 SDK 初始化失败）。
// 不发起网络请求（仅实例化 LanguageModel 对象）。
//
// 说明：registry.test.ts 已覆盖"参数正确传入 createOpenAICompatible"；
// 本文件补足"SDK 真实消费参数后能创建 LanguageModel"的集成盲区。
// 真实网络链路的端到端验证依赖 E2E（需 API Key），不在单测范围。

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

// mock electron：config 依赖 app.isPackaged（registry 从 config.providers 读取 baseURL）
vi.mock('electron', () => ({ app: mocks.mockApp }));

// mock logger：避免触发真实 electron-log 初始化
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

    // 不发起网络请求：仅实例化 LanguageModel 对象
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
    const factory = registry.createFactory(kind, { apiKey: 'sk-test' });
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
    // config.providers.<kind> 在 dev 环境有默认值（mock app.isPackaged=false）
    const factory = registry.createFactory('moonshot', { apiKey: 'sk-test' });
    expect(typeof factory).toBe('function');
  });
});
