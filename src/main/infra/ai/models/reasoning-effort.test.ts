// src/main/infra/ai/models/reasoning-effort.test.ts
// 思考强度阶梯单测：归一化 / 钳制 / DeepSeek 官方映射
//
// 测试要点：
// 1. normalizeReasoningEffort：别名归一化 / 无法识别返回 undefined
// 2. clampReasoningEffort：受支持保留 / 取更强档 / 封顶到最强档
// 3. clampDeepSeekReasoningEffort：应用官方映射表（xhigh→flash:high/pro:max 等）

import { describe, expect, it } from 'vitest';
import {
  clampDeepSeekReasoningEffort,
  clampReasoningEffort,
  normalizeReasoningEffort,
} from './reasoning-effort';

describe('normalizeReasoningEffort（归一化）', () => {
  it('标准档位：原样归一化', () => {
    expect(normalizeReasoningEffort('low')).toBe('low');
    expect(normalizeReasoningEffort('high')).toBe('high');
    expect(normalizeReasoningEffort('max')).toBe('max');
  });

  it('常见别名：归一化到规范档位', () => {
    expect(normalizeReasoningEffort('med')).toBe('medium');
    expect(normalizeReasoningEffort('x-high')).toBe('xhigh');
    expect(normalizeReasoningEffort('extra_high')).toBe('xhigh');
    expect(normalizeReasoningEffort('maximum')).toBe('max');
    expect(normalizeReasoningEffort('  LOW ')).toBe('low');
  });

  it('无法识别 / 空输入：返回 undefined', () => {
    expect(normalizeReasoningEffort('ultra')).toBeUndefined();
    expect(normalizeReasoningEffort('')).toBeUndefined();
    expect(normalizeReasoningEffort(undefined)).toBeUndefined();
    expect(normalizeReasoningEffort(null)).toBeUndefined();
  });
});

describe('clampReasoningEffort（钳制）', () => {
  it('请求档位受支持：原样保留', () => {
    expect(clampReasoningEffort('high', ['low', 'high', 'max'])).toBe('high');
  });

  it('请求档位不受支持：取下一个更强档位', () => {
    // xhigh(60) → 支持集 [low, high, max] 中 ≥60 的最小档 = max(70)
    expect(clampReasoningEffort('xhigh', ['low', 'high', 'max'])).toBe('max');
    // medium(30) → 支持集 [low, high, max] 中 ≥30 的最小档 = high(40)
    expect(clampReasoningEffort('medium', ['low', 'high', 'max'])).toBe('high');
  });

  it('请求档位高于全部支持档：封顶到最强可用档', () => {
    // max(70) → 支持集 [low, high] 无 ≥70 的档 → 封顶 high
    expect(clampReasoningEffort('max', ['low', 'high'])).toBe('high');
  });

  it('未提供支持集：不钳制（全阶梯）', () => {
    expect(clampReasoningEffort('xhigh')).toBe('xhigh');
    expect(clampReasoningEffort('max')).toBe('max');
  });
});

describe('clampDeepSeekReasoningEffort（DeepSeek 官方映射）', () => {
  it('v4-flash：官方映射表（low→low / high→high / xhigh→high / max→max）', () => {
    expect(clampDeepSeekReasoningEffort('deepseek-v4-flash', 'low')).toBe('low');
    expect(clampDeepSeekReasoningEffort('deepseek-v4-flash', 'high')).toBe('high');
    expect(clampDeepSeekReasoningEffort('deepseek-v4-flash', 'xhigh')).toBe('high');
    expect(clampDeepSeekReasoningEffort('deepseek-v4-flash', 'max')).toBe('max');
  });

  it('v4-pro：官方映射表（low→high / high→high / xhigh→max / max→max）', () => {
    expect(clampDeepSeekReasoningEffort('deepseek-v4-pro', 'low')).toBe('high');
    expect(clampDeepSeekReasoningEffort('deepseek-v4-pro', 'high')).toBe('high');
    expect(clampDeepSeekReasoningEffort('deepseek-v4-pro', 'xhigh')).toBe('max');
    expect(clampDeepSeekReasoningEffort('deepseek-v4-pro', 'max')).toBe('max');
  });
});
