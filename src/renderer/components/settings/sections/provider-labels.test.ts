// src/renderer/components/settings/sections/provider-labels.test.ts
// providerLabel / providerApiKeyUrl 测试（kind → i18n 显示名/官网地址）
// ──────────────────────────────────────────────────────────────
// 2026-09-27 label 纳管 i18n：providerLabel 改为 (kind, t) 注入式签名，
// 测试用恒等 fake t 断言 key 解析路径；译文本身由语言包 + check-i18n 门禁守护。
// ──────────────────────────────────────────────────────────────

import { describe, expect, it } from 'vitest';

import { PROVIDER_LABELS, providerApiKeyUrl, providerLabel } from './provider-labels';

/** 恒等翻译：返回 key 本身（验证 key 形状与调用路径） */
const identityT = (key: string): string => key;

describe('providerLabel', () => {
  it('已收录 kind → 返回 i18n key（providers 顶层组）', () => {
    expect(providerLabel('deepseek', identityT)).toBe('providers.deepseek');
    expect(providerLabel('anthropic', identityT)).toBe('providers.anthropic');
    expect(providerLabel('zhipu', identityT)).toBe('providers.zhipu');
  });

  it('未收录 kind → 回退 kind 原文', () => {
    expect(providerLabel('unknown-provider' as never, identityT)).toBe('unknown-provider');
  });

  it('kind 无重复', () => {
    const kinds = PROVIDER_LABELS.map((p) => p.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});

describe('providerApiKeyUrl', () => {
  it('已收录 kind → 官网地址', () => {
    expect(providerApiKeyUrl('deepseek')).toBe('https://platform.deepseek.com');
    expect(providerApiKeyUrl('openai')).toBe('https://platform.openai.com/api-keys');
  });

  it('未收录 kind → 回退空串', () => {
    expect(providerApiKeyUrl('unknown-provider' as never)).toBe('');
  });
});

describe('PROVIDER_LABELS', () => {
  it('每项官网地址均为 https', () => {
    for (const item of PROVIDER_LABELS) {
      expect(item.apiKeyUrl.startsWith('https://')).toBe(true);
    }
  });
});
