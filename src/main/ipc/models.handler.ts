// src/main/ipc/models.handler.ts
// 模型域 handler（models:list + models:listBuiltin + models:test）
// ──────────────────────────────────────────────────────────────
// 职责：
// - models:list：暴露主进程 modelRegistry 中**已配置可用**的模型清单
//   （对齐同类桌面 LLM 客户端：配置好才显示，未配置不出现——没有就是没有）
//   仅适用于聊天框模型选择器
// - models:listBuiltin：厂商内置模型全集（不依赖 keychain 配置状态）——
//   配置页数据源（配置页恰恰为未配置用户服务，"配置好才显示"会造成死锁）
// - models:test：连通性测试——真实 HTTP 探测供应商端点（不落库、不改状态）
// ──────────────────────────────────────────────────────────────

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

/** 连通性测试超时（毫秒） */
const TEST_TIMEOUT_MS = 10_000;

/**
 * 目标是否指向本机环回（models:test 连通性测试的放行依据）
 *
 * 环回 = localhost / *.localhost 主机名，或 127/8、::1（含 IPv4 映射/兼容形式）
 * 字面量。与 url-guard 的 isBlockedHostname / isBlockedAddress 语义区别：
 * web_fetch 出站的发起方是模型（环回探测 = SSRF，必须拦）；models:test 的
 * 发起方是用户本人（本地 Ollama / 自建推理服务是合法目标，环回应放行）。
 * 两个威胁模型不同，守卫不共用；*.local / *.internal / 元数据域名不在环回
 * 之列（仍按受限处理，交由 url-guard 拦截）。
 */
function isLoopbackTarget(hostname: string): boolean {
  // URL.hostname 对 IPv6 字面量带方括号（如 [::1]），与 url-guard 同样剥除
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

/** 根地址拼接规则已收敛至 endpoint.ts 单一真源（见 buildTestUrl 注释） */

/**
 * 拼接探测目标 URL
 *
 * 单一真源：与真实调用共用 resolveProviderRequestUrl（同一份端点归一化规则
 * + 与 SDK 源码一致的协议路径，随 API 格式变化）。此前本文件自带纯字符串拼接，
 * 既不 trim 尾斜杠也不做 /v1 幂等判断——用户填 `http://host/v1`（自定义模式
 * 常见填法）时探测打到 `/v1/v1/chat/completions` 得 404，**在保存前拦住了
 * 本可正常使用的配置**（2026-10-08 修复；同类事故 2026-09-06 已出现过一次，
 * 当时只修了调用路径）。
 */
function buildTestUrl(
  providerKind: ProviderKind,
  baseUrl: string,
  apiFormat: ModelApiFormat,
): string {
  return resolveProviderRequestUrl(providerKind, baseUrl, apiFormat);
}

/**
 * 构造探测请求体与格式专属头
 *
 * 三格式的请求体差异（权威来源：AI SDK 各 provider 的 getArgs 实现）：
 * - openai-chat：`{ model, max_tokens, messages }`
 * - openai-responses：`{ model, max_output_tokens, input }`（Responses 无
 *   messages 字段，用错字段会被网关判 400 —— 假阴性）
 * - anthropic-messages：`{ model, max_tokens, messages }` + anthropic-version 头
 */
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

/**
 * 显式 baseUrl 的安全校验（连通性测试专用）
 *
 * 2026-09-08 安全修复（密钥外泄原语）：渲染层此前可传任意 baseUrl 并省略
 * apiKey，主进程会回退 keychain 里的真实密钥并发往该 URL（无白名单）。
 * 现在：显式 baseUrl 必须同时显式提供 apiKey——不允许用真实密钥探测
 * 任意端点；同时拒绝私网/链路本地/云元数据地址（SSRF）。
 * 2026-10-07 修正：loopback（localhost/127.0.0.1/[::1]）**放行**——本地
 * Ollama / 自建推理服务是合法用法（providerKind='ollama' 的默认端点就是
 * localhost:11434，自定义端口只能显式填地址）。此前借用 web_fetch 的
 * url-guard 一律拦环回，与本注释承诺相反且与保存路径（无校验）不一致：
 * 守卫发起方是用户本人在设置面操作（非模型出站），环回风险可接受。
 *
 * @throws AppError(INVALID_INPUT) 缺 apiKey / URL 非法 / 指向受限网段
 */
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

/** models 域 handler（定义表驱动，InferHandlers 编译期约束） */
export const modelsHandlers = {
  /**
   * 模型清单（对话区/设置页共用）：返回用户显式配置且启用的模型记录
   *
   * 语义（2026-09-04 与用户确认）：
   * - 一个模型一条记录，设置页配置/启停后此处才出现（配置一个显示一个）。
   * - 服务商模式的记录同样存于 runtimeModelStore（providerKind + 具体 modelId，
   *   API Key 走厂商级 keychain）——服务商直连 = 配 Key 即用，但"模型"本身
   *   由配置弹窗选择并保存，不做"未配置就凭空并入"（无论默认模型或全量内置）。
   * - 真实数据源 = runtimeModelStore（用户配置的模型唯一入口）。
   *   厂商内置模型全集在配置页经 listBuiltin 提供（作为服务商模式的下拉候选）。
   */
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

  /**
   * 厂商内置模型全集（配置页下拉数据源）
   *
   * 不做 keychain 过滤：配置页为未配置用户服务，需展示厂商全部官方模型
   * 供选择（未配置也能看到要配什么）。providerKind 省略时返回全部厂商。
   */
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

  /**
   * 连通性测试：POST 最小请求到供应商端点
   *
   * - API Key 回退链：input.apiKey → 提供商 keychain → 运行时模型 keychain
   * - 401/403 判为密钥无效；其余非 2xx 返回状态码；网络异常返回错误信息
   * - 只读探测：不落库、不注册、不消耗业务数据
   */
  test: async (input: {
    providerKind: ProviderKind;
    modelId?: string | undefined;
    baseUrl: string | undefined;
    apiKey: string | undefined;
    apiFormat?: ModelApiFormat | undefined;
  }): Promise<TestModelRes> => {
    const { providerKind } = input;
    const baseUrl = input.baseUrl ?? getAppConfig().providers[providerKind];
    // 生效格式：显式传入 > 已存运行时模型的记录 > 该 kind 默认
    // （保存前测试时模型尚未落库，走显式传入；编辑历史模型时为记录值）
    const storedFormat =
      input.apiFormat ??
      (input.modelId !== undefined
        ? (await runtimeModelStore.get(input.modelId))?.apiFormat
        : undefined);
    const apiFormat = resolveApiFormat(providerKind, storedFormat);

    if (input.baseUrl !== undefined) {
      assertSafeTestBaseUrl(input.baseUrl, input.apiKey);
    }

    // API Key 回退链（显式优先）
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
          // anthropic 用 x-api-key；其余（含 Responses）用 Bearer
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
      // 附上实际探测 URL：拼接/协议选错类问题（如 /v1/v1、格式与端点不匹配）
      // 一眼可辨，无需反查代码
      return { ok: false, error: `HTTP ${response.status}（${url}）` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  },
};
