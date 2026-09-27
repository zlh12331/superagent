// src/renderer/components/settings/sections/provider-labels.test.ts
// providerLabel / providerApiKeyUrl 纯函数测试（kind → 显示名/官网）

import { describe, expect, it } from 'vitest';

import { PROVIDER_LABELS, providerApiKeyUrl, providerLabel } from './provider-labels';

describe('providerLabel', () => {
  it('已收录 kind → 显示名', () => {
    expect(providerLabel('deepseek')).toBe('DeepSeek');
    expect(providerLabel('anthropic')).toBe('Anthropic');
    expect(providerLabel('ollama')).toBe('Ollama');
  });

  it('未收录 kind → 回退 kind 原文', () => {
    expect(providerLabel('unknown-provider' as never)).toBe('unknown-provider');
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
  it('每项都有非空 label 与 https 官网', () => {
    for (const item of PROVIDER_LABELS) {
      expect(item.label.length).toBeGreaterThan(0);
      expect(item.apiKeyUrl.startsWith('https://')).toBe(true);
    }
  });

  it('kind 无重复', () => {
    const kinds = PROVIDER_LABELS.map((p) => p.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });
});
