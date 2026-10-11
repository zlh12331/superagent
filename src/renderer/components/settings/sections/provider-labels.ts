import type { ApiKeyProvider } from '@code-agent/shared/renderer';

/** t() 的最小结构签名（避免本数据模块依赖 i18next 实例） */
type TranslateFn = (key: string) => string;

/**
 * 预设厂商列表（kind + API Key 官网地址；显示名经 i18n key 解析）。
 *
 * ⚠ 只收录**深度适配**的厂商——预设网格的语义是「适配好的开箱即用」，
 * 协议通但无精细适配的厂商走「自定义模型」入口（baseUrl/apiFormat 自填）。
 * 新厂商完成深度适配（thinking 契约/usage 归一/模型清单核对官方文档）后再加回。
 */
export const PROVIDER_LABELS: readonly {
  readonly kind: ApiKeyProvider;
  /** API Key 申请页官网地址（「获取 API 密钥」链接跳转） */
  readonly apiKeyUrl: string;
}[] = [
  { kind: 'deepseek', apiKeyUrl: 'https://platform.deepseek.com' },
  { kind: 'zhipu', apiKeyUrl: 'https://open.bigmodel.cn' },
  { kind: 'mimo', apiKeyUrl: 'https://mimo.mi.com' },
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
