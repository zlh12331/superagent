// src/main/infra/ai/providers/registry.test.ts
// ProviderRegistry 单测：注册表元数据 + 工厂路由
//
// 测试要点：
// 1. 内置 4 个供应商定义（deepseek/openai/anthropic/ollama）
// 2. getDefaultKind：isDefault 标记优先，无标记回落到第一个
// 3. createFactory：按 kind 路由到对应 SDK 工厂（OpenAI Compatible / OpenAI / Anthropic）
// 4. baseURL 拼接规则：deepseek/openai/ollama 拼 /v1，anthropic 直接用
// 5. 未知 kind：抛错
// 6. 空注册表：getDefaultKind 抛错

import { beforeEach, describe, expect, it, vi } from 'vitest';

// 与 ai-provider.test.ts 相同的 mock 模式：
// - electron：config 依赖 app.isPackaged
// - @ai-sdk/*：拦截 SDK 工厂，避免真实网络/依赖
const mocks = vi.hoisted(() => {
  const mockProviderFactory = vi.fn();
  return {
    mockProviderFactory,
    mockCreateOpenAICompatible: vi.fn(() => mockProviderFactory),
    mockCreateOpenAI: vi.fn(() => mockProviderFactory),
    mockCreateAnthropic: vi.fn(() => mockProviderFactory),
    mockApp: {
      isPackaged: false,
      getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
    },
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: mocks.mockCreateOpenAICompatible,
}));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: mocks.mockCreateOpenAI }));
vi.mock('@ai-sdk/anthropic', () => ({ createAnthropic: mocks.mockCreateAnthropic }));
vi.mock('electron', () => ({ app: mocks.mockApp }));
vi.mock('../../../utils/logger', () => ({ logger: mocks.mockLogger }));

import { ProviderRegistry } from './registry';
import type { ProviderKind } from './types';

describe('ProviderRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('内置供应商', () => {
    it('注册 4 个供应商，kind 集合完整', () => {
      const registry = new ProviderRegistry();
      const kinds = registry.list().map((i) => i.kind);
      expect(kinds.sort()).toEqual(['anthropic', 'deepseek', 'ollama', 'openai'].sort());
    });

    it('deepseek：默认供应商，需要 API Key', () => {
      const registry = new ProviderRegistry();
      const info = registry.list().find((i) => i.kind === 'deepseek');
      expect(info).toMatchObject({
        displayName: 'DeepSeek',
        defaultModel: 'deepseek-chat',
        requiresApiKey: true,
        isDefault: true,
      });
    });

    it('ollama：本地服务，不需要 API Key，非默认', () => {
      const registry = new ProviderRegistry();
      const info = registry.list().find((i) => i.kind === 'ollama');
      expect(info).toMatchObject({
        requiresApiKey: false,
        isDefault: false,
      });
    });

    it('getDefinition：未知 kind 抛错', () => {
      const registry = new ProviderRegistry();
      // @ts-expect-error 故意传非法 kind 验证运行时校验
      expect(() => registry.getDefinition('unknown')).toThrow(/未知模型供应商/);
    });
  });

  describe('getDefaultKind', () => {
    it('默认注册表：返回 isDefault 标记的 deepseek', () => {
      const registry = new ProviderRegistry();
      expect(registry.getDefaultKind()).toBe('deepseek');
    });

    it('无 isDefault 标记：回落到第一个注册的供应商', () => {
      // 自定义空定义注册表：传入不含 isDefault 的定义
      const registry = new ProviderRegistry([
        {
          kind: 'openai',
          displayName: 'OpenAI',
          defaultModel: 'gpt-4o',
          requiresApiKey: true,
        },
        {
          kind: 'ollama',
          displayName: 'Ollama',
          defaultModel: 'qwen2.5-coder:7b',
          requiresApiKey: false,
        },
      ]);
      expect(registry.getDefaultKind()).toBe('openai');
    });

    it('空注册表：抛错', () => {
      const registry = new ProviderRegistry([]);
      expect(() => registry.getDefaultKind()).toThrow(/注册表为空/);
    });
  });

  describe('createFactory', () => {
    it('deepseek：走 OpenAI Compatible，baseURL 拼接 /v1，传 apiKey', () => {
      const registry = new ProviderRegistry();
      const factory = registry.createFactory('deepseek', { apiKey: 'sk-test' });
      expect(factory).toBe(mocks.mockProviderFactory);
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
      type DeepseekConfig = {
        name: string;
        baseURL: string;
        apiKey: string;
        includeUsage: boolean;
      };
      const calls = mocks.mockCreateOpenAICompatible.mock.calls as unknown as [DeepseekConfig][];
      const config = calls[0]?.[0];
      expect(config).toMatchObject({
        name: 'deepseek',
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-test',
        includeUsage: true,
      });
    });

    it('openai：走 @ai-sdk/openai，baseURL 拼接 /v1', () => {
      const registry = new ProviderRegistry();
      registry.createFactory('openai', { apiKey: 'sk-test' });
      expect(mocks.mockCreateOpenAI).toHaveBeenCalledTimes(1);
      // mock.calls 类型推断为空元组，用 as unknown as 访问首参
      type OpenAIConfig = { baseURL: string };
      const calls = mocks.mockCreateOpenAI.mock.calls as unknown as [OpenAIConfig][];
      expect(calls[0]?.[0].baseURL).toBe('https://api.openai.com/v1');
    });

    it('anthropic：走 @ai-sdk/anthropic，baseURL 直接用（无 /v1）', () => {
      const registry = new ProviderRegistry();
      registry.createFactory('anthropic', { apiKey: 'sk-test' });
      expect(mocks.mockCreateAnthropic).toHaveBeenCalledTimes(1);
      type AnthropicConfig = { baseURL: string };
      const calls = mocks.mockCreateAnthropic.mock.calls as unknown as [AnthropicConfig][];
      expect(calls[0]?.[0].baseURL).toBe('https://api.anthropic.com');
    });

    it('ollama：走 OpenAI Compatible，无需 apiKey 字段，baseURL 拼接 /v1', () => {
      const registry = new ProviderRegistry();
      registry.createFactory('ollama', { apiKey: undefined });
      expect(mocks.mockCreateOpenAICompatible).toHaveBeenCalledTimes(1);
      type OllamaConfig = { name: string; baseURL: string; apiKey: string };
      const calls = mocks.mockCreateOpenAICompatible.mock.calls as unknown as [OllamaConfig][];
      const config = calls[0]?.[0];
      expect(config?.name).toBe('ollama');
      expect(config?.baseURL).toBe('http://localhost:11434/v1');
    });

    it('未知 kind：抛错', () => {
      const registry = new ProviderRegistry();
      expect(() =>
        registry.createFactory('unknown' as ProviderKind, { apiKey: undefined }),
      ).toThrow(/未知模型供应商/);
    });
  });
});
