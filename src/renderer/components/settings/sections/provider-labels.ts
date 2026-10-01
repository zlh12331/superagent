// src/renderer/components/settings/sections/provider-labels.ts
// 提供商显示名映射（显示名走 i18n 语言包，官网地址为静态数据）
// ──────────────────────────────────────────────────────────────
// kind 集合单一真源为 shared ApiKeyProviderSchema；本文件仅维护
// kind → 官网地址的静态映射 + 显示名的 i18n 解析（ProvidersSection /
// 添加模型弹窗共用）。
//
// 2026-09-27 纳管 i18n：显示名 key 化（providers.<kind>，双语语言包顶层组），
// 组件以 providerLabel(kind, t) 取译文——t 由调用方传入（useTranslation），
// 语言切换后随组件重渲染即时生效；未收录 kind 回退 kind 原文。
// 模板串内联在 t() 调用处：check-i18n 据此收集动态前缀（providers.），
// 豁免该域 key 的冗余校验。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';

/** t() 的最小结构签名（避免本数据模块依赖 i18next 实例） */
type TranslateFn = (key: string) => string;

/** 内置提供商列表（kind + API Key 官网地址；显示名经 i18n key 解析） */
export const PROVIDER_LABELS: readonly {
  readonly kind: ApiKeyProvider;
  /** API Key 申请页官网地址（「获取 API 密钥」链接跳转） */
  readonly apiKeyUrl: string;
}[] = [
  { kind: 'deepseek', apiKeyUrl: 'https://platform.deepseek.com' },
  { kind: 'openai', apiKeyUrl: 'https://platform.openai.com/api-keys' },
  { kind: 'anthropic', apiKeyUrl: 'https://console.anthropic.com' },
  { kind: 'ollama', apiKeyUrl: 'https://ollama.com' },
  { kind: 'moonshot', apiKeyUrl: 'https://platform.moonshot.cn' },
  { kind: 'zhipu', apiKeyUrl: 'https://open.bigmodel.cn' },
  { kind: 'qwen', apiKeyUrl: 'https://bailian.console.aliyun.com' },
  { kind: 'doubao', apiKeyUrl: 'https://console.volcengine.com/ark' },
  { kind: 'siliconflow', apiKeyUrl: 'https://cloud.siliconflow.cn' },
  { kind: 'openrouter', apiKeyUrl: 'https://openrouter.ai' },
];

/**
 * kind → 显示名（i18n 译文；未收录时回退 kind 原文）
 *
 * @param kind 提供商标识
 * @param t 翻译函数（组件经 useTranslation 获取，保证语言态新鲜）
 */
export function providerLabel(kind: ApiKeyProvider, t: TranslateFn): string {
  const known = PROVIDER_LABELS.some((p) => p.kind === kind);
  return known ? t(`providers.${kind}`) : kind;
}

/** kind → API Key 官网地址（未收录时回退空串） */
export function providerApiKeyUrl(kind: ApiKeyProvider): string {
  return PROVIDER_LABELS.find((p) => p.kind === kind)?.apiKeyUrl ?? '';
}
