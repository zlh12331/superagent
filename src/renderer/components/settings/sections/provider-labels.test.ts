import { describe, expect, it } from 'vitest';

import { PROVIDER_LABELS, providerApiKeyUrl, providerLabel } from './provider-labels';

/** 恒等翻译：返回 key 本身（验证 key 形状与调用路径） */
const identityT = (key: string): string => key;

describe('providerLabel', () => {
  it('已收录 kind → 返回 i18n key（providers 顶层组）', () => {
    expect(providerLabel('deepseek', identityT)).toBe('providers.deepseek');
    expect(providerLabel('mimo', identityT)).toBe('providers.mimo');
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
    expect(providerApiKeyUrl('mimo')).toBe('https://mimo.mi.com');
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

  // ⚠ 预设=深度适配契约：收录即承诺 thinking 契约/usage 归一/模型清单经官方文档核对
  it('只收录深度适配厂商（预设语义守卫——新厂商完成适配后在此登记）', () => {
    const kinds = PROVIDER_LABELS.map((p) => p.kind).sort();
    expect(kinds).toEqual(['deepseek', 'mimo', 'zhipu']);
  });
});
