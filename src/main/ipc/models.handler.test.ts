// src/main/ipc/models.handler.test.ts
// models.handler 单测：models:list 过滤语义 + models:test 连通性探测
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - modelRegistry/keychain/config 为外部依赖 → vi.mock
// - fetch 为网络边界 → vi.stubGlobal 注入 fake（业务判定逻辑保持真实）
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { modelsHandlers } from './models.handler';

/** 测试用占位凭据（非真实密钥，仅用于触发「显式 baseUrl 需同时传 key」分支） */
const PLACEHOLDER_CREDENTIAL = 'placeholder-not-real';

const mocks = vi.hoisted(() => ({
  // 返回类型显式标注：避免 vi.fn(() => []) 推导 never[] 导致 mockReturnValue 赋值报错
  listModels: vi.fn((): Array<Record<string, unknown>> => []),
  findBuiltin: vi.fn((_modelId: string) => undefined as Record<string, unknown> | undefined),
  listRuntimeModels: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  // 运行时模型单条查询（test 的 apiFormat 回退来源：已存记录值）
  getRuntimeModel: vi.fn(
    async (_modelId: string): Promise<Record<string, unknown> | undefined> => undefined,
  ),
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
  modelRegistry: { listModels: mocks.listModels, findBuiltin: mocks.findBuiltin },
}));

vi.mock('../infra/ai/llm-client/ai-provider', () => ({
  runtimeModelStore: { list: mocks.listRuntimeModels, get: mocks.getRuntimeModel },
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

/** 构造运行时模型记录（list 数据源形状） */
function runtimeModel(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    modelId: 'my-model',
    providerKind: 'deepseek',
    isEnabled: true,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('models:list（模型清单 = 用户配置且启用的模型记录，一条记录一个模型）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listRuntimeModels.mockResolvedValue([]);
  });

  it('只返回用户配置且启用的模型记录（未配置的厂商内置模型不出现）', async () => {
    mocks.listRuntimeModels.mockResolvedValue([runtimeModel()]);
    const res = await modelsHandlers.list();
    expect(res.models).toHaveLength(1);
    expect(res.models[0]).toMatchObject({
      id: 'my-model',
      providerKind: 'deepseek',
      isRuntime: true,
    });
    // list 不做 keychain 探测（厂商内置模型全量绝不凭空并入——配置一个显示一个）
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it('关闭（isEnabled=false）的模型不显示；启用才出现', async () => {
    mocks.listRuntimeModels.mockResolvedValue([
      runtimeModel({ modelId: 'disabled-model', isEnabled: false }),
    ]);
    const res = await modelsHandlers.list();
    expect(res.models).toHaveLength(0);
  });

  it('启用多个 → 全部显示；label 优先 displayName → 内置 displayName → modelId', async () => {
    mocks.listRuntimeModels.mockResolvedValue([
      runtimeModel({ modelId: 'a', displayName: '我的模型', isEnabled: true }),
    ]);
    mocks.findBuiltin.mockReturnValue({ displayName: '内置名' } as never);
    const res = await modelsHandlers.list();
    expect(res.models[0]?.label).toBe('我的模型');

    // 无 displayName + 无内置条目 → 回退 modelId
    mocks.findBuiltin.mockReturnValue(undefined);
    mocks.listRuntimeModels.mockResolvedValue([
      runtimeModel({ modelId: 'b', displayName: undefined }),
    ]);
    const res2 = await modelsHandlers.list();
    expect(res2.models[0]?.label).toBe('b');
  });

  it('runtime 模型无内置条目时 capabilities 为空对象（不抛错）', async () => {
    mocks.listRuntimeModels.mockResolvedValue([runtimeModel()]);
    mocks.findBuiltin.mockReturnValue(undefined);
    const res = await modelsHandlers.list();
    expect(res.models[0]?.capabilities).toEqual({});
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

  it('apiFormat=openai-responses：打 /responses + responses 形态请求体', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(200));
    const res = await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: 'gpt-5',
      baseUrl: 'http://127.0.0.1:9527',
      apiKey: PLACEHOLDER_CREDENTIAL,
      apiFormat: 'openai-responses',
    });

    expect(res).toEqual({ ok: true });
    const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9527/v1/responses');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    // Responses 用 max_output_tokens + input（无 messages）
    // biome-ignore lint/style/useNamingConvention: 供应商 API 协议字段（snake_case）
    expect(body).toMatchObject({ model: 'gpt-5', max_output_tokens: 1, input: 'ping' });
    expect(body).not.toHaveProperty('messages');
  });

  it('apiFormat=anthropic-messages：打 /messages + x-api-key + anthropic-version', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(200));
    await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: 'claude-x',
      baseUrl: 'http://127.0.0.1:9527',
      apiKey: PLACEHOLDER_CREDENTIAL,
      apiFormat: 'anthropic-messages',
    });

    const [url, init] = mocks.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9527/messages');
    const headers = init.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe(PLACEHOLDER_CREDENTIAL);
    expect(headers['anthropic-version']).toBeDefined();
    expect(headers['authorization']).toBeUndefined();
  });

  it('apiFormat 省略但 modelId 命中已存记录：用记录的格式探测', async () => {
    // 编辑历史模型时表单未显式下发格式，主进程按已存记录值探测
    mocks.getRuntimeModel.mockResolvedValueOnce({ apiFormat: 'openai-responses' });
    mocks.fetch.mockResolvedValueOnce(respond(200));
    await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: 'my-stored-model',
      baseUrl: 'http://127.0.0.1:9527',
      apiKey: PLACEHOLDER_CREDENTIAL,
    });

    const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://127.0.0.1:9527/v1/responses');
  });

  it('500：ok=false + 状态码提示', async () => {
    mocks.fetch.mockResolvedValueOnce(respond(500));
    const res = await modelsHandlers.test({
      providerKind: 'openrouter',
      modelId: undefined,
      baseUrl: undefined,
      apiKey: undefined,
    });
    // 错误文案带实际探测 URL（拼接/协议选错类问题一眼可辨）
    expect(res.ok).toBe(false);
    expect(res.error).toContain('HTTP 500');
    // openrouter 默认地址已含 /v1：不重复拼接
    const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(res.error).toContain(url);
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
    // 2026-09-08：显式 baseUrl 必须同时提供 apiKey（防用真实密钥探测任意端点）
    await modelsHandlers.test({
      providerKind: 'deepseek',
      modelId: undefined,
      baseUrl: 'https://self-hosted.example.com',
      apiKey: PLACEHOLDER_CREDENTIAL,
    });
    const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('https://self-hosted.example.com/v1/chat/completions');
  });

  it('显式 baseUrl 缺 apiKey：拒绝（防密钥外泄）', async () => {
    await expect(
      modelsHandlers.test({
        providerKind: 'deepseek',
        modelId: undefined,
        baseUrl: 'https://attacker.example.com',
        apiKey: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('显式 baseUrl 指向本机环回：放行（本地 Ollama / 自建推理服务）', async () => {
    // 2026-10-07 修正：环回不再借用 web_fetch 的 SSRF 一律拦截——测试的
    // 发起方是用户本人，本地推理端点（含自定义端口）是合法探测目标
    mocks.fetch.mockResolvedValue(respond(200));
    for (const baseUrl of [
      'http://127.0.0.1:11434',
      'http://localhost:9000',
      'http://[::1]:9000',
    ]) {
      const res = await modelsHandlers.test({
        providerKind: 'ollama',
        modelId: undefined,
        baseUrl,
        apiKey: PLACEHOLDER_CREDENTIAL,
      });
      expect(res).toEqual({ ok: true });
    }
    const [url] = mocks.fetch.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions');
  });

  it('显式 baseUrl 指向环回但缺 apiKey：仍拒绝（密钥外泄防线不放宽）', async () => {
    await expect(
      modelsHandlers.test({
        providerKind: 'ollama',
        modelId: undefined,
        baseUrl: 'http://127.0.0.1:11434',
        apiKey: undefined,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('显式 baseUrl 指向私网/元数据：仍拒绝（环回放行不外溢到受限网段）', async () => {
    for (const baseUrl of [
      'http://192.168.1.1:8080',
      'http://10.0.0.5:3000',
      'http://metadata.google.internal',
      'http://my-service.local',
    ]) {
      await expect(
        modelsHandlers.test({
          providerKind: 'openai',
          modelId: undefined,
          baseUrl,
          apiKey: PLACEHOLDER_CREDENTIAL,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
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
