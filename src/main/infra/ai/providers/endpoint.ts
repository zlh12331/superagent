// endpoint.ts：供应商端点策略——根地址补 /v1 后缀规则 + API 格式协议路径 + 请求 URL 拼装
// （config/ 的 baseURL 表只存根地址，协议路径由本文件负责——两处职责分开）
import type { ModelApiFormat } from '@code-agent/shared/main';

import type { ProviderKind } from './types';

const ANTHROPIC_OFFICIAL_URL = 'https://api.anthropic.com';

// 每家供应商的端点策略：fillVersionSuffix=根地址缺后缀时补什么；
// onlyWhenEquals=仅官方地址才补（anthropic 自托管网关不带 /v1）
interface EndpointPolicy {
  readonly fillVersionSuffix: string | null;
  readonly onlyWhenEquals?: string;
}

const ENDPOINT_POLICIES: Record<ProviderKind, EndpointPolicy> = {
  deepseek: { fillVersionSuffix: '/v1' },
  openai: { fillVersionSuffix: '/v1' },
  ollama: { fillVersionSuffix: '/v1' },
  anthropic: { fillVersionSuffix: '/v1', onlyWhenEquals: ANTHROPIC_OFFICIAL_URL },
  moonshot: { fillVersionSuffix: null },
  zhipu: { fillVersionSuffix: null },
  qwen: { fillVersionSuffix: null },
  doubao: { fillVersionSuffix: null },
  siliconflow: { fillVersionSuffix: null },
  openrouter: { fillVersionSuffix: null },
};

function trimTrailingSlash(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function resolveProviderBaseUrl(kind: ProviderKind, baseUrl: string): string {
  const trimmed = trimTrailingSlash(baseUrl);
  const { fillVersionSuffix, onlyWhenEquals } = ENDPOINT_POLICIES[kind];
  if (fillVersionSuffix === null) {
    return trimmed;
  }
  if (onlyWhenEquals !== undefined && trimmed !== onlyWhenEquals) {
    return trimmed;
  }
  return trimmed.endsWith(fillVersionSuffix) ? trimmed : `${trimmed}${fillVersionSuffix}`;
}

/** API 格式 → 协议路径（models.handler 探针与 registry 构建共用） */
const PROTOCOL_PATHS: Record<ModelApiFormat, string> = {
  'openai-chat': '/chat/completions',
  'openai-responses': '/responses',
  'anthropic-messages': '/messages',
};

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

export function resolveApiFormat(kind: ProviderKind, apiFormat?: ModelApiFormat): ModelApiFormat {
  return apiFormat ?? DEFAULT_API_FORMAT_BY_KIND[kind];
}

export function defaultApiFormat(kind: ProviderKind): ModelApiFormat {
  return DEFAULT_API_FORMAT_BY_KIND[kind];
}

function protocolFamily(kind: ProviderKind, apiFormat: ModelApiFormat): ProviderKind {
  if (apiFormat === 'anthropic-messages') {
    return 'anthropic';
  }
  if (apiFormat === 'openai-responses') {
    return 'openai';
  }
  return kind;
}

export function resolveProviderRequestUrl(
  kind: ProviderKind,
  baseUrl: string,
  apiFormat?: ModelApiFormat,
): string {
  const effectiveFormat = resolveApiFormat(kind, apiFormat);
  const base = resolveProviderBaseUrl(protocolFamily(kind, effectiveFormat), baseUrl);
  return `${base}${PROTOCOL_PATHS[effectiveFormat]}`;
}
