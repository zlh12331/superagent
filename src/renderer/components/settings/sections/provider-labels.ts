// src/renderer/components/settings/sections/provider-labels.ts
// 提供商显示名映射（静态 UI 文案，非配置型数据）
// ──────────────────────────────────────────────────────────────
// kind 集合单一真源为 shared ApiKeyProviderSchema；本文件仅维护
// kind → 显示名/官网地址的静态映射（ProvidersSection / 添加模型弹窗共用）。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';

/** 内置提供商列表（显示名 + 供应商枚举 + API Key 官网地址） */
export const PROVIDER_LABELS: readonly {
  readonly kind: ApiKeyProvider;
  readonly label: string;
  /** API Key 申请页官网地址（「获取 API 密钥」链接跳转） */
  readonly apiKeyUrl: string;
}[] = [
  { kind: 'deepseek', label: 'DeepSeek', apiKeyUrl: 'https://platform.deepseek.com' },
  { kind: 'openai', label: 'OpenAI', apiKeyUrl: 'https://platform.openai.com/api-keys' },
  { kind: 'anthropic', label: 'Anthropic', apiKeyUrl: 'https://console.anthropic.com' },
  { kind: 'ollama', label: 'Ollama', apiKeyUrl: 'https://ollama.com' },
  { kind: 'moonshot', label: 'Moonshot Kimi', apiKeyUrl: 'https://platform.moonshot.cn' },
  { kind: 'zhipu', label: '智谱 GLM', apiKeyUrl: 'https://open.bigmodel.cn' },
  { kind: 'qwen', label: '通义千问', apiKeyUrl: 'https://bailian.console.aliyun.com' },
  { kind: 'doubao', label: '豆包（火山方舟）', apiKeyUrl: 'https://console.volcengine.com/ark' },
  { kind: 'siliconflow', label: '硅基流动', apiKeyUrl: 'https://cloud.siliconflow.cn' },
  { kind: 'openrouter', label: 'OpenRouter', apiKeyUrl: 'https://openrouter.ai' },
];

/** kind → 显示名（未收录时回退 kind 原文） */
export function providerLabel(kind: ApiKeyProvider): string {
  return PROVIDER_LABELS.find((p) => p.kind === kind)?.label ?? kind;
}

/** kind → API Key 官网地址（未收录时回退空串） */
export function providerApiKeyUrl(kind: ApiKeyProvider): string {
  return PROVIDER_LABELS.find((p) => p.kind === kind)?.apiKeyUrl ?? '';
}
