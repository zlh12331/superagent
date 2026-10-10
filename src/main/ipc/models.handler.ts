// models.handler.ts：models 域 IPC——运行时/内置模型清单 + 模型连通性测试（设置面模型管理消费）
import type {
  AvailableModelInfo,
  ModelApiFormat,
  ModelsListBuiltinRes,
  ModelsListRes,
  TestModelRes,
} from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import { getAppConfig } from '../config';
import { runtimeModelStore } from '../infra/ai/llm-client/ai-provider';
import { modelRegistry } from '../infra/ai/models';
import { runtimeModelKeychainKey } from '../infra/ai/models/runtime-model-store';
import { resolveApiFormat, resolveProviderRequestUrl } from '../infra/ai/providers/endpoint';
import type { ProviderKind } from '../infra/ai/providers/types';
import { isBlockedAddress, isBlockedHostname } from '../infra/ai/tools/url-guard';
import { getSecret } from '../infra/storage/keychain';

// 连通性探针 10s 超时：真实推理请求（max_tokens=1），慢网关不值得久等
const TEST_TIMEOUT_MS = 10_000;

// 环回判定要覆盖 IPv4/IPv6/IPv4-mapped IPv6 各写法——SSRF 校验漏一种写法就是洞
function isLoopbackTarget(hostname: string): boolean {
  const host = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return true;
  }
  if (host === '::1') {
    return true;
  }
  return /^::(?:ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function buildTestUrl(
  providerKind: ProviderKind,
  baseUrl: string,
  apiFormat: ModelApiFormat,
): string {
  return resolveProviderRequestUrl(providerKind, baseUrl, apiFormat);
}

// 最小探针请求按 API 格式分型：三种格式（anthropic/openai-responses/其余 OpenAI Compatible）
// 的必填字段与版本头不同，探针要严格贴合各格式否则误报连通失败
function buildProbeRequest(
  apiFormat: ModelApiFormat,
  model: string,
): { readonly body: Record<string, unknown>; readonly extraHeaders: Record<string, string> } {
  if (apiFormat === 'anthropic-messages') {
    return {
      body: {
        model,
        // biome-ignore lint/style/useNamingConvention: 供应商 API 协议字段（snake_case）
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      },
      extraHeaders: { 'anthropic-version': '2023-06-01' },
    };
  }
  if (apiFormat === 'openai-responses') {
    return {
      body: {
        model,
        // biome-ignore lint/style/useNamingConvention: 供应商 API 协议字段（snake_case）
        max_output_tokens: 1,
        input: 'ping',
      },
      extraHeaders: {},
    };
  }
  return {
    body: {
      model,
      // biome-ignore lint/style/useNamingConvention: 供应商 API 协议字段（snake_case）
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    },
    extraHeaders: {},
  };
}

// SSRF 防线：自定义 baseUrl 探测必须显式携带 apiKey（不许拿已存密钥打任意端点），
// 且目标不得是内网/云元数据地址（环回地址除外——本地网关是合法场景）
function assertSafeTestBaseUrl(baseUrl: string, apiKey: string | undefined): void {
  if (apiKey === undefined) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      '自定义 baseUrl 时必须同时提供 apiKey（不允许用已保存的密钥探测任意端点）',
    );
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    throw new AppError(ErrorCode.INVALID_INPUT, `非法的 baseUrl：${baseUrl}`);
  }
  const isLoopback = isLoopbackTarget(parsedUrl.hostname);
  if (
    !isLoopback &&
    (isBlockedHostname(parsedUrl.hostname) || isBlockedAddress(parsedUrl.hostname))
  ) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `baseUrl 指向受限地址（内网/元数据）：${parsedUrl.hostname}`,
    );
  }
}

export const modelsHandlers = {
  list: async (): Promise<ModelsListRes> => {
    const records = await runtimeModelStore.list();
    const models: AvailableModelInfo[] = [];
    for (const r of records) {
      if (!r.isEnabled) continue;
      const entry = modelRegistry.findBuiltin(r.modelId);
      models.push({
        id: r.modelId,
        label: r.displayName ?? entry?.displayName ?? r.modelId,
        providerKind: r.providerKind,
        isRuntime: true,
        capabilities: { ...(entry?.capabilities ?? {}) } as Record<string, unknown>,
      });
    }
    return { models };
  },

  listBuiltin: async (input: {
    providerKind?: ProviderKind | undefined;
  }): Promise<ModelsListBuiltinRes> => {
    const all = modelRegistry.listModels();
    const builtins = all.filter(
      (m) =>
        !m.isRuntime && (input.providerKind === undefined || m.providerKind === input.providerKind),
    );
    return {
      models: builtins.map((m) => ({
        id: m.id,
        label: m.label,
        providerKind: m.providerKind,
        isRuntime: m.isRuntime,
        capabilities: { ...m.capabilities } as Record<string, unknown>,
      })),
    };
  },

  test: async (input: {
    providerKind: ProviderKind;
    modelId?: string | undefined;
    baseUrl: string | undefined;
    apiKey: string | undefined;
    apiFormat?: ModelApiFormat | undefined;
  }): Promise<TestModelRes> => {
    const { providerKind } = input;
    const baseUrl = input.baseUrl ?? getAppConfig().providers[providerKind];
    const storedFormat =
      input.apiFormat ??
      (input.modelId !== undefined
        ? (await runtimeModelStore.get(input.modelId))?.apiFormat
        : undefined);
    const apiFormat = resolveApiFormat(providerKind, storedFormat);

    if (input.baseUrl !== undefined) {
      assertSafeTestBaseUrl(input.baseUrl, input.apiKey);
    }

    let apiKey = input.apiKey;
    if (apiKey === undefined) {
      apiKey = (await getSecret(`${providerKind}-api-key`)) ?? undefined;
    }
    if (apiKey === undefined && input.modelId !== undefined) {
      apiKey = (await getSecret(runtimeModelKeychainKey(input.modelId))) ?? undefined;
    }

    const url = buildTestUrl(providerKind, baseUrl, apiFormat);
    const probe = buildProbeRequest(apiFormat, input.modelId ?? 'ping');
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(apiFormat === 'anthropic-messages'
            ? { 'x-api-key': apiKey ?? '' }
            : apiKey !== undefined
              ? { authorization: `Bearer ${apiKey}` }
              : {}),
          ...probe.extraHeaders,
        },
        body: JSON.stringify(probe.body),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return { ok: true };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: 'API Key 无效或未授权' };
      }
      return { ok: false, error: `HTTP ${response.status}（${url}）` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  },
};
