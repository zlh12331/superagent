// src/renderer/components/chat/suggest-trigger.test.ts
// 斜杠/提及建议触发检测纯函数回归（对齐参考项目 useSlashSuggest 触发语义）

import { describe, expect, it } from 'vitest';

import { detectSuggestTrigger } from './suggest-trigger';

describe('detectSuggestTrigger', () => {
  it('无触发词 → null', () => {
    expect(detectSuggestTrigger('hello world').activeTrigger).toBeNull();
  });

  it('行首 / 触发 slash，查询段为 / 之后文本', () => {
    const s = detectSuggestTrigger('/co');
    expect(s.activeTrigger).toBe('slash');
    expect(s.activeQuery).toBe('co');
    expect(s.slashIndex).toBe(0);
  });

  it('行中 / 也触发（支持任意位置）', () => {
    const s = detectSuggestTrigger('帮我 /he');
    expect(s.activeTrigger).toBe('slash');
    expect(s.activeQuery).toBe('he');
  });

  it('查询段含空格 → 不触发', () => {
    expect(detectSuggestTrigger('/he llo').activeTrigger).toBeNull();
  });

  it('slash 查询超 20 字符 → 不触发', () => {
    expect(detectSuggestTrigger(`/${'a'.repeat(21)}`).activeTrigger).toBeNull();
    expect(detectSuggestTrigger(`/${'a'.repeat(20)}`).activeTrigger).toBe('slash');
  });

  it('@ 触发 mention（≤30 字符；查询段不含 / ——含 / 时位置靠后的 slash 接管）', () => {
    const s = detectSuggestTrigger('看下 @src-ma');
    expect(s.activeTrigger).toBe('mention');
    expect(s.activeQuery).toBe('src-ma');
    expect(detectSuggestTrigger(`@${'a'.repeat(31)}`).activeTrigger).toBeNull();
  });

  it('位置靠后者触发：@ 在 / 之后 → mention；/ 在 @ 之后 → slash', () => {
    expect(detectSuggestTrigger('/x @y').activeTrigger).toBe('mention');
    expect(detectSuggestTrigger('@x /y').activeTrigger).toBe('slash');
  });

  it('空串不触发', () => {
    expect(detectSuggestTrigger('').activeTrigger).toBeNull();
  });

  it('空查询段（仅触发词）→ 触发且查询为空串', () => {
    const s = detectSuggestTrigger('/');
    expect(s.activeTrigger).toBe('slash');
    expect(s.activeQuery).toBe('');
  });
});
