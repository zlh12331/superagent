// src/renderer/components/chat/slash-suggestions.test.ts
// 斜杠建议表与过滤纯函数回归（自 ChatInput 提取后的独立验证）

import { describe, expect, it } from 'vitest';

import {
  filterSlashSuggestions,
  findSlashSuggestion,
  SLASH_SUGGESTIONS,
} from './slash-suggestions';

describe('SLASH_SUGGESTIONS', () => {
  it('命令均带 / 前缀且唯一', () => {
    const commands = SLASH_SUGGESTIONS.map((s) => s.command);
    expect(commands.every((c) => c.startsWith('/'))).toBe(true);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it('带 action 的命令均有 labelKey（下拉展示用）', () => {
    for (const s of SLASH_SUGGESTIONS) {
      expect(s.labelKey.length).toBeGreaterThan(0);
    }
  });
});

describe('filterSlashSuggestions', () => {
  it('空查询匹配全部命令', () => {
    expect(filterSlashSuggestions('')).toHaveLength(SLASH_SUGGESTIONS.length);
  });

  it('前缀匹配：/co → /compact', () => {
    const result = filterSlashSuggestions('co');
    expect(result.map((s) => s.command)).toEqual(['/compact']);
  });

  it('/in 同时匹配 /interrupt（前缀语义，非包含）', () => {
    const commands = filterSlashSuggestions('in').map((s) => s.command);
    expect(commands).toContain('/interrupt');
    expect(commands).not.toContain('/demo'); // 非 in 前缀
  });

  it('无匹配返回空数组', () => {
    expect(filterSlashSuggestions('zzz')).toEqual([]);
  });
});

describe('findSlashSuggestion', () => {
  it('按完整命令名查找（含 action）', () => {
    expect(findSlashSuggestion('/new')?.action).toBe('new');
  });

  it('未知命令返回 undefined', () => {
    expect(findSlashSuggestion('/nope')).toBeUndefined();
  });
});
