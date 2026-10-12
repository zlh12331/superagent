import type { ModelApiFormat } from '@code-agent/shared/main';
import type { LanguageModel } from 'ai';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveProviderRequestUrl } from './endpoint';
import { ProviderRegistry } from './registry';
import type { ProviderKind } from './types';

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

let capturedUrls: string[] = [];

function stubUrlCapturingFetch(): void {
  capturedUrls = [];
  vi.stubGlobal('fetch', async (url: unknown): Promise<never> => {
    capturedUrls.push(String(url));
    throw new Error('captured-abort');
  });
}

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
    } catch {}
    const url = capturedUrls[0];
    if (url !== undefined) {
      return url;
    }
  }
  throw new Error('未能捕获任何请求 URL（SDK 未发起 fetch？）');
}

const CASES: ReadonlyArray<{ kind: ProviderKind; baseUrl: string }> = [
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
