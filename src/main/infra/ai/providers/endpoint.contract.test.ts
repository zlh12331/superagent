// src/main/infra/ai/providers/endpoint.contract.test.ts
// 端点推导 ↔ AI SDK 实际请求 URL 的契约测试
// ──────────────────────────────────────────────────────────────
// 目的（本方案的核心价值）：证明 resolveProviderRequestUrl 预测的 URL 与
// SDK 真实构造的 URL 逐字相同——端点归一化规则不是"我以为的规则"，而是与
// SDK 源码行为绑定的稳定契约。SDK 换版本改了拼接规则 → CI 直接红，而不是
// 等用户在保存模型时看到 404。
//
// 手法：真实工厂（不 mock @ai-sdk/*）+ stub 全局 fetch 捕获 SDK 构造的 URL
// 后立即抛错（零网络零 token）。stub fetch 属基础设施替身，符合项目
// 「业务逻辑不 mock、基础设施可替身」的分层原则。
// ──────────────────────────────────────────────────────────────

import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveProviderRequestUrl } from './endpoint';
import { ProviderRegistry } from './registry';
import type { ProviderKind } from './types';

/** 测试用占位凭据（非真实密钥；SDK 需非空 key 才会构造授权头） */
const PLACEHOLDER_CREDENTIAL = 'placeholder-not-real';

const mocks = vi.hoisted(() => ({
  mockApp: {
    isPackaged: false,
    getPath: vi.fn((name: string) => `/tmp/test-userdata/${name}`),
  },
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('electron', () => ({ app: mocks.mockApp }));
vi.mock('../../utils/logger', () => ({ logger: mocks.mockLogger }));

/** 捕获到的请求 URL（每次 stub 重置） */
let capturedUrls: string[] = [];

/**
 * stub 全局 fetch：记录 URL 后抛错
 *
 * 工厂链路是 provider → proxiedFetch → 全局 fetch（非 fixed 代理模式直通），
 * stub 全局 fetch 即覆盖全部供应商（含官方 SDK anthropic/openai）。
 */
function stubUrlCapturingFetch(): void {
  capturedUrls = [];
  vi.stubGlobal('fetch', async (url: unknown): Promise<never> => {
    capturedUrls.push(String(url));
    throw new Error('captured-abort');
  });
}

/**
 * 触发一次模型调用并取回 SDK 构造的 URL
 *
 * doStream/doGenerate 任一试通即可（不同 provider 实现路径不同）；调用参数
 * 故意最小——SDK 在构造 URL 后才校验请求体，URL 捕获先于任何语义校验。
 * 类型经结构断言放宽（`LanguageModel` 为联合类型，v4 接口在运行期同为
 * doGenerate/doStream，与 registry-factory.test 的既有写法一致）。
 */
async function captureRequestUrl(model: LanguageModel): Promise<string> {
  const callable = model as unknown as {
    doStream: (options: unknown) => Promise<unknown>;
    doGenerate: (options: unknown) => Promise<unknown>;
  };
  for (const call of ['doStream', 'doGenerate'] as const) {
    try {
      await callable[call]({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        maxOutputTokens: 1,
      });
    } catch {
      // 预期：captured fetch 抛错，或 SDK 对最小参数的其他拒绝——都只看捕获结果
    }
    const url = capturedUrls[0];
    if (url !== undefined) {
      return url;
    }
  }
  throw new Error('未能捕获任何请求 URL（SDK 未发起 fetch？）');
}

/** 用例矩阵：kind + 用户可能填写的 baseUrl 形态 */
const CASES: ReadonlyArray<{ kind: ProviderKind; baseUrl: string }> = [
  // 2026-10-08 缺陷场景（自定义模式恒为 deepseek，用户按 OpenAI 习惯填 /v1）
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527/v1' },
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527' },
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527/' },
  { kind: 'openai', baseUrl: 'https://self-hosted.example.com/v1' },
  { kind: 'openai', baseUrl: 'https://self-hosted.example.com' },
  { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434' },
  { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' },
  { kind: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1' },
  { kind: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { kind: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { kind: 'anthropic', baseUrl: 'https://my-gw.example.com' },
  { kind: 'anthropic', baseUrl: 'https://my-gw.example.com/v1' },
];

/**
 * 显式 API 格式用例矩阵（自定义模型三格式切换）
 *
 * 锁定「用户选的格式 = SDK 实际请求的协议」——格式选错（如选 responses 却
 * 仍打 chat/completions）会让真实调用与探测/UI 三方分裂。
 */
const FORMAT_CASES: ReadonlyArray<{
  kind: ProviderKind;
  baseUrl: string;
  apiFormat: ModelApiFormat;
}> = [
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527', apiFormat: 'openai-chat' },
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527/v1', apiFormat: 'openai-chat' },
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527', apiFormat: 'openai-responses' },
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527/v1', apiFormat: 'openai-responses' },
  { kind: 'deepseek', baseUrl: 'http://127.0.0.1:9527', apiFormat: 'anthropic-messages' },
  { kind: 'openai', baseUrl: 'https://self-hosted.example.com', apiFormat: 'openai-responses' },
  { kind: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiFormat: 'anthropic-messages' },
];

describe('端点推导契约（resolveProviderRequestUrl ↔ SDK 实际请求 URL）', () => {
  let registry: ProviderRegistry;

  beforeAll(() => {
    registry = new ProviderRegistry();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(CASES)('$kind · $baseUrl：预测值与 SDK 实际请求一致', async ({ kind, baseUrl }) => {
    stubUrlCapturingFetch();
    const factory = registry.createFactory(kind, {
      apiKey: PLACEHOLDER_CREDENTIAL,
      baseUrl,
    });
    const model = factory('test-model') as unknown as LanguageModel;

    const actualUrl = await captureRequestUrl(model);

    expect(actualUrl).toBe(resolveProviderRequestUrl(kind, baseUrl));
  });

  it.each(FORMAT_CASES)(
    '$kind · $apiFormat · $baseUrl：显式格式的路由与预测一致',
    async ({ kind, baseUrl, apiFormat }) => {
      stubUrlCapturingFetch();
      const factory = registry.createFactory(kind, {
        apiKey: PLACEHOLDER_CREDENTIAL,
        baseUrl,
        apiFormat,
      });
      const model = factory('test-model') as unknown as LanguageModel;

      const actualUrl = await captureRequestUrl(model);

      expect(actualUrl).toBe(resolveProviderRequestUrl(kind, baseUrl, apiFormat));
    },
  );
});
