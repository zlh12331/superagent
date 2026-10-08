// src/main/infra/ai/providers/endpoint.test.ts
// 端点 URL 推导单测（纯函数矩阵）
//
// 背景：端点 URL 曾有两份实现（调用路径 registry.ts 幂等、探测路径
// models.handler.ts 不幂等），用户填 `/v1` 结尾地址时探测 404 拦保存。
// 本文件锁定收敛后的单一真源语义，并含用户实际场景的回归用例。
//
// 与 SDK 的一致性另有独立契约测试（endpoint.contract.test.ts）——用真工厂
// 捕获 SDK 实际请求 URL 对照本模块预测值，两端不可能静默漂移。

import { describe, expect, it } from 'vitest';
import { resolveProviderBaseUrl, resolveProviderRequestUrl } from './endpoint';
import { PROVIDER_KINDS } from './types';

describe('resolveProviderBaseUrl（交给 SDK 的 baseURL）', () => {
  it('deepseek/openai/ollama：缺失 /v1 时补齐', () => {
    for (const kind of ['deepseek', 'openai', 'ollama'] as const) {
      expect(resolveProviderBaseUrl(kind, 'http://127.0.0.1:9527')).toBe(
        'http://127.0.0.1:9527/v1',
      );
    }
  });

  it('deepseek/openai/ollama：已含 /v1 时不重复追加（幂等，历史 404 根因）', () => {
    for (const kind of ['deepseek', 'openai', 'ollama'] as const) {
      expect(resolveProviderBaseUrl(kind, 'http://127.0.0.1:9527/v1')).toBe(
        'http://127.0.0.1:9527/v1',
      );
    }
  });

  it('尾斜杠：单个/多个一律去除（拼 // 会让部分网关 404）', () => {
    expect(resolveProviderBaseUrl('deepseek', 'https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/v1',
    );
    expect(resolveProviderBaseUrl('deepseek', 'https://api.deepseek.com///')).toBe(
      'https://api.deepseek.com/v1',
    );
    expect(resolveProviderBaseUrl('moonshot', 'https://api.moonshot.cn/v1/')).toBe(
      'https://api.moonshot.cn/v1',
    );
  });

  it('已含版本段的供应商（moonshot/zhipu/qwen/doubao/siliconflow/openrouter）：不追加 /v1', () => {
    // 这些供应商的默认地址自带版本段（/api/paas/v4、/compatible-mode/v1 等），
    // 无条件补 /v1 会拼出 /v4/v1 这类无效路径
    expect(resolveProviderBaseUrl('zhipu', 'https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    );
    expect(resolveProviderBaseUrl('openrouter', 'https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1',
    );
    expect(
      resolveProviderBaseUrl('qwen', 'https://dashscope.aliyuncs.com/compatible-mode/v1'),
    ).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1');
  });

  it('anthropic：仅官方地址补 /v1（对齐 SDK normalizeBaseURL 语义）', () => {
    expect(resolveProviderBaseUrl('anthropic', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1',
    );
    expect(resolveProviderBaseUrl('anthropic', 'https://api.anthropic.com/')).toBe(
      'https://api.anthropic.com/v1',
    );
  });

  it('anthropic：自建网关原样透传（不补 /v1）', () => {
    expect(resolveProviderBaseUrl('anthropic', 'https://my-gw.example.com')).toBe(
      'https://my-gw.example.com',
    );
    expect(resolveProviderBaseUrl('anthropic', 'https://my-gw.example.com/v1')).toBe(
      'https://my-gw.example.com/v1',
    );
  });

  it('每个 ProviderKind 都有策略（新增供应商须显式表态，无静默漏配）', () => {
    for (const kind of PROVIDER_KINDS) {
      expect(typeof resolveProviderBaseUrl(kind, 'https://example.com')).toBe('string');
    }
  });
});

describe('resolveProviderRequestUrl（探测目标完整 URL）', () => {
  it('OpenAI 兼容族：base + /chat/completions', () => {
    expect(resolveProviderRequestUrl('deepseek', 'https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(resolveProviderRequestUrl('openrouter', 'https://openrouter.ai/api/v1')).toBe(
      'https://openrouter.ai/api/v1/chat/completions',
    );
    expect(resolveProviderRequestUrl('ollama', 'http://127.0.0.1:11434')).toBe(
      'http://127.0.0.1:11434/v1/chat/completions',
    );
  });

  it('anthropic：base + /messages（官方补 /v1，自建网关不补）', () => {
    expect(resolveProviderRequestUrl('anthropic', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(resolveProviderRequestUrl('anthropic', 'https://my-gw.example.com')).toBe(
      'https://my-gw.example.com/messages',
    );
  });

  it('回归（用户实际场景）：deepseek + http://127.0.0.1:9527/v1 不再拼出 /v1/v1', () => {
    // 2026-10-08 缺陷：自定义模式 providerKind 恒为 deepseek，用户按
    // OpenAI 习惯填 `/v1` 结尾地址 → 探测 /v1/v1/chat/completions → 404
    // → 保存被拦（真实调用经幂等归一化反而是对的）
    const url = resolveProviderRequestUrl('deepseek', 'http://127.0.0.1:9527/v1');
    expect(url).toBe('http://127.0.0.1:9527/v1/chat/completions');
    expect(url).not.toContain('/v1/v1');
  });

  it('回归：尾斜杠输入不产生 // 路径', () => {
    const url = resolveProviderRequestUrl('deepseek', 'http://127.0.0.1:9527/');
    expect(url).toBe('http://127.0.0.1:9527/v1/chat/completions');
    expect(url).not.toContain('//v1');
  });
});
