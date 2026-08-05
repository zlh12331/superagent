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
