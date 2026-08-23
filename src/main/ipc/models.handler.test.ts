// src/main/ipc/models.handler.test.ts
// models.handler 单测：models:list 过滤语义 + models:test 连通性探测
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - modelRegistry/keychain/config 为外部依赖 → vi.mock
// - fetch 为网络边界 → vi.stubGlobal 注入 fake（业务判定逻辑保持真实）
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { modelsHandlers } from './models.handler';

const mocks = vi.hoisted(() => ({
  // 返回类型显式标注：避免 vi.fn(() => []) 推导 never[] 导致 mockReturnValue 赋值报错
  listModels: vi.fn((): Array<Record<string, unknown>> => []),
  getSecret: vi.fn(async () => undefined),
  getProviders: vi.fn(() => ({
    deepseek: 'https://api.deepseek.com',
    openai: 'https://api.openai.com',
    anthropic: 'https://api.anthropic.com',
    ollama: 'http://localhost:11434',
    moonshot: 'https://api.moonshot.cn/v1',
    zhipu: 'https://open.bigmodel.cn/api/paas/v4',
    qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    doubao: 'https://ark.cn-beijing.volces.com/api/v3',
    siliconflow: 'https://api.siliconflow.cn/v1',
    openrouter: 'https://openrouter.ai/api/v1',
  })),
  fetch: vi.fn(),
}));

vi.mock('../infra/ai/models', () => ({
  modelRegistry: { listModels: mocks.listModels },
}));

vi.mock('../infra/storage/keychain', () => ({
  getSecret: mocks.getSecret,
}));

vi.mock('../infra/ai/models/runtime-model-store', () => ({
  runtimeModelKeychainKey: (modelId: string) => `runtime:${modelId}`,
}));

vi.mock('../config', () => ({
  getAppConfig: () => ({ providers: mocks.getProviders() }),
}));

/** 构造 fetch 响应 fake */
function respond(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body ?? {},
  } as Response;
}

describe('models:listBuiltin（配置页厂商下拉数据源）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSecret.mockResolvedValue(undefined);
  });

  it('不做 keychain 过滤：未配置 Key 的厂商内置模型也返回（修复配置页死锁）', async () => {
    mocks.listModels.mockReturnValue([
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        providerKind: 'deepseek',
        isRuntime: false,
        capabilities: {},
      },
      {
        id: 'gpt-4o',
        label: 'GPT-4o',
        providerKind: 'openai',
        isRuntime: false,
        capabilities: {},
      },
    ]);
    // keychain 全空（新用户场景）——list 会过滤掉全部，listBuiltin 必须返回
    const res = await modelsHandlers.listBuiltin({ providerKind: 'deepseek' });
    expect(res.models).toHaveLength(1);
    expect(res.models[0]?.id).toBe('deepseek-v4-flash');
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it('providerKind 省略：返回全部厂商内置模型（排除运行时模型）', async () => {
    mocks.listModels.mockReturnValue([
      {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek V4 Flash',
        providerKind: 'deepseek',
        isRuntime: false,
        capabilities: {},
      },
      {
        id: 'my-custom-model',
        label: 'my-custom-model',
        providerKind: 'openai',
        isRuntime: true,
        capabilities: {},
      },
    ]);
    const res = await modelsHandlers.listBuiltin({});
    expect(res.models).toHaveLength(1);
    expect(res.models[0]?.id).toBe('deepseek-v4-flash');
  });
});

describe('models.handler test（连通性探测）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSecret.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mocks.fetch);
  });

  it('200：ok=true；deepseek 拼 /v1/chat/completions + Bearer key', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(200));
    const res = await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: 'deepseek-chat',
      baseUrl: undefined,
      apiKey: 'sk-explicit',
    });
    expect(res).toEqual({ ok: true });
    const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-explicit');
  });

  it('401：ok=false + 密钥无效提示', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(401));
    const res = await modelsHandlers.test({
      providerKind: 'openai',
      modelId: undefined,
      baseUrl: undefined,
      apiKey: 'bad-key',
    });
    expect(res).toEqual({ ok: false, error: 'API Key 无效或未授权' });
  });

  it('500：ok=false + 状态码提示', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(500));
    const res = await modelsHandlers.test({
      providerKind: 'openrouter',
      modelId: undefined,
      baseUrl: undefined,
      apiKey: undefined,
    });
    expect(res).toEqual({ ok: false, error: 'HTTP 500' });
    // openrouter 默认地址已含 /v1：不重复拼接
    const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  it('anthropic：/v1/messages + x-api-key header', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(200));
    await modelsHandlers.test({
      providerKind: 'anthropic',
      modelId: 'claude-sonnet',
      baseUrl: undefined,
      apiKey: 'sk-ant',
    });
    const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-ant');
  });

  it('apiKey 回退链：未传显式 key → 读提供商 keychain', async () => {
    mocks.getSecret.mockResolvedValueOnce('sk-keychain' as never);
    mocks.fetch.mockResolvedValueOnce(respond(200));
    await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: undefined,
      baseUrl: undefined,
      apiKey: undefined,
    });
    const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-keychain');
  });

  it('apiKey 回退链：提供商无 key → 运行时模型 key', async () => {
    mocks.getSecret
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce('sk-runtime' as never);
    mocks.fetch.mockResolvedValueOnce(respond(200));
    await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: 'my-model',
      baseUrl: undefined,
      apiKey: undefined,
    });
    expect(mocks.getSecret).toHaveBeenNthCalledWith(2, 'runtime:my-model');
    const [, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer sk-runtime');
  });

  it('显式 baseUrl：覆盖默认端点', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(200));
    await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: undefined,
      baseUrl: 'https://self-hosted.example.com',
      apiKey: undefined,
    });
    const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://self-hosted.example.com/v1/chat/completions');
  });

  it('fetch 异常：ok=false + 异常信息', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const res = await modelsHandlers.test({
      providerKind: 'ollama',
      modelId: undefined,
      baseUrl: undefined,
      apiKey: undefined,
    });
    expect(res).toEqual({ ok: false, error: 'ECONNREFUSED' });
  });
});
