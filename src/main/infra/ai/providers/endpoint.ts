// src/main/infra/ai/providers/endpoint.ts
// 供应商端点 URL 推导（单一真源，纯函数零依赖）
// ──────────────────────────────────────────────────────────────
// 背景（2026-10-08 缺陷修复）：端点 URL 此前有**两份独立实现**且规则不同——
// - 调用路径（registry.ts 工厂）：trimTrailingSlash + withOpenAiV1（/v1 幂等）
// - 连通性探测（models.handler.ts 的 buildTestUrl）：纯字符串拼接，既不 trim
//   也不去重 → 用户填 `http://127.0.0.1:9527/v1`（自定义模式的常见填法）时
//   探测打到 `/v1/v1/chat/completions` 得 404，**在保存前就拦住了本可正常
//   使用的配置**（真实调用经 withOpenAiV1 反而是对的）。
// 同类事故 2026-09-06 已修过一次（只修了调用路径），根因是"同一事实两处各算
// 一遍"——本模块把它收敛为唯一实现，两条路径共用。
//
// 设计依据（AI SDK 源码实读，勿凭印象改）：
// - `@ai-sdk/openai-compatible` 3.0.43：`baseURL = withoutTrailingSlash(options.baseURL)`
//   （仅去单个尾部斜杠），URL = `new URL(`${baseURL}${path}`)`，chat path = `/chat/completions`
// - `@ai-sdk/openai` 4.0.58：同形（`withoutTrailingSlash` + `/chat/completions`）
// - `@ai-sdk/anthropic` 4.0.49：`normalizeBaseURL` **仅当 baseURL 恰为官方地址
//   `https://api.anthropic.com` 时**补 `/v1`，自建网关原样透传；URL = `${baseURL}/messages`
//
// 本模块输出的是「交给 SDK 的 baseURL」与「该配置最终请求的完整 URL」两个口径：
// 前者给工厂（SDK 会再拼协议路径），后者给连通性探测（自己拼协议路径）。
// 两者共用同一份端点归一化规则，结构上不可能再漂移。
// ──────────────────────────────────────────────────────────────

import type { ModelApiFormat } from '@code-agent/shared/main';

import type { ProviderKind } from './types';

/** Anthropic 官方 API 根地址（SDK 也以此为补 /v1 的判据，见文件头） */
const ANTHROPIC_OFFICIAL_URL = 'https://api.anthropic.com';

/**
 * 端点归一化策略
 *
 * - `fillVersionSuffix`：默认/常见填法不含版本段，缺失时补齐（**幂等**：
 *   已以该后缀结尾则不重复追加——这是 2026-09-06 与 2026-10-08 两次 404 的
 *   共同根因，务必保持幂等语义）
 * - `onlyWhenEquals`：仅当 baseUrl 归一化后恰等于该地址才补版本段
 *   （对齐 AI SDK 自带的官方地址特判，避免与 SDK 语义冲突）
 * - `null`：不补（默认地址已含版本段，如 zhipu 的 /api/paas/v4）
 *
 * Record<ProviderKind, …> 保证新增供应商时编译器强制表态，不会静默漏配。
 */
interface EndpointPolicy {
  /** 缺失时补齐的版本后缀（null = 不补） */
  readonly fillVersionSuffix: string | null;
  /** 仅当归一化后等于该地址才补版本后缀（省略 = 总是按上一条规则处理） */
  readonly onlyWhenEquals?: string;
}

const ENDPOINT_POLICIES: Record<ProviderKind, EndpointPolicy> = {
  // 根地址 + SDK 拼 /chat/completions → 需要 /v1 段
  deepseek: { fillVersionSuffix: '/v1' },
  openai: { fillVersionSuffix: '/v1' },
  ollama: { fillVersionSuffix: '/v1' },
  // anthropic 协议路径是 /messages；SDK 只对官方地址补 /v1，自建网关原样
  // ——此处对齐 SDK 语义（否则探测 /v1/messages 与真实调用 /messages 不一致）
  anthropic: { fillVersionSuffix: '/v1', onlyWhenEquals: ANTHROPIC_OFFICIAL_URL },
  // 默认地址已含版本段（/v1、/api/paas/v4、/compatible-mode/v1 等），不补
  moonshot: { fillVersionSuffix: null },
  zhipu: { fillVersionSuffix: null },
  qwen: { fillVersionSuffix: null },
  doubao: { fillVersionSuffix: null },
  siliconflow: { fillVersionSuffix: null },
  openrouter: { fillVersionSuffix: null },
};

/** 去掉尾部全部斜杠（`//` 双写会让部分网关直接 404，2026-09-06 审计修复） */
function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/**
 * 归一化端点（去尾斜杠 + 按策略补齐版本段，幂等）
 *
 * @param kind 供应商标识（决定补齐策略）
 * @param baseUrl 用户填写的根地址（默认地址来自 config.providers.<kind>）
 * @returns 交给 SDK 的 baseURL（无尾斜杠）
 */
export function resolveProviderBaseUrl(kind: ProviderKind, baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  const { fillVersionSuffix, onlyWhenEquals } = ENDPOINT_POLICIES[kind];
  if (fillVersionSuffix === null) {
    return trimmed;
  }
  if (onlyWhenEquals !== undefined && trimmed !== onlyWhenEquals) {
    return trimmed;
  }
  // 幂等：已以该后缀结尾则不重复追加（`/v1/v1/…` → 404 的历史根因）
  return trimmed.endsWith(fillVersionSuffix) ? trimmed : `${trimmed}${fillVersionSuffix}`;
}

/** 协议路径（必须与 SDK 内部使用的 path 逐字一致，见各自源码依据） */
const PROTOCOL_PATHS: Record<ModelApiFormat, string> = {
  // @ai-sdk/openai-compatible 3.0.43 / @ai-sdk/openai 4.0.58：path: "/chat/completions"
  'openai-chat': '/chat/completions',
  // @ai-sdk/openai 4.0.58（createResponsesModel）：path: "/responses"
  'openai-responses': '/responses',
  // @ai-sdk/anthropic 4.0.49：`${baseURL}/messages`
  'anthropic-messages': '/messages',
};

/**
 * 供应商的默认 API 格式（未显式指定格式时的路由目标）
 *
 * 语义：服务商模式（用户只选厂商）走各自厂商的原生协议；自定义模式未选格式
 * 时回落 `openai-chat`（兼容面最广，也是本字段引入前的历史行为）。
 */
const DEFAULT_API_FORMAT_BY_KIND: Record<ProviderKind, ModelApiFormat> = {
  deepseek: 'openai-chat',
  openai: 'openai-chat',
  ollama: 'openai-chat',
  moonshot: 'openai-chat',
  zhipu: 'openai-chat',
  qwen: 'openai-chat',
  doubao: 'openai-chat',
  siliconflow: 'openai-chat',
  openrouter: 'openai-chat',
  anthropic: 'anthropic-messages',
};

/**
 * 解析生效的 API 格式
 *
 * @param kind 供应商标识
 * @param apiFormat 显式指定的格式（自定义模型快照携带；undefined = 按 kind 默认）
 * @returns 实际生效的格式
 */
export function resolveApiFormat(kind: ProviderKind, apiFormat?: ModelApiFormat): ModelApiFormat {
  return apiFormat ?? DEFAULT_API_FORMAT_BY_KIND[kind];
}

/** 该供应商的默认（原生）API 格式 */
export function defaultApiFormat(kind: ProviderKind): ModelApiFormat {
  return DEFAULT_API_FORMAT_BY_KIND[kind];
}

/**
 * 端点归一化所依据的"协议族"
 *
 * 与 `resolveApiFormat` 配合：格式决定协议路径，协议族决定版本段补齐规则。
 * - anthropic-messages：按 anthropic 规则（仅官方地址补 /v1，自建网关原样）
 * - openai-responses：按 openai 规则（根地址补 /v1 —— Responses 端点在 /v1 下）
 * - openai-chat：沿用 kind 自身策略（六家默认地址已含版本段的供应商不补，
 *   与既有行为一致；deepseek/openai/ollama 型根地址补 /v1）
 */
function protocolFamily(kind: ProviderKind, apiFormat: ModelApiFormat): ProviderKind {
  if (apiFormat === 'anthropic-messages') {
    return 'anthropic';
  }
  if (apiFormat === 'openai-responses') {
    return 'openai';
  }
  return kind;
}

/**
 * 该端点配置最终会被请求的完整 URL（连通性探测专用）
 *
 * @param kind 供应商标识
 * @param baseUrl 用户填写的根地址
 * @param apiFormat 显式 API 格式（省略 = 按 kind 默认）
 * @returns 完整请求 URL（探测目标）
 */
export function resolveProviderRequestUrl(
  kind: ProviderKind,
  baseUrl: string,
  apiFormat?: ModelApiFormat,
): string {
  const effectiveFormat = resolveApiFormat(kind, apiFormat);
  const base = resolveProviderBaseUrl(protocolFamily(kind, effectiveFormat), baseUrl);
  return `${base}${PROTOCOL_PATHS[effectiveFormat]}`;
}
