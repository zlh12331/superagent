// src/renderer/hooks/__tests__/use-conversation-search.test.ts
// 会话内搜索单测：匹配纯函数（大小写/多匹配/空查询/无匹配）

import type { UIMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { findMessageMatches } from '../use-conversation-search';

/** 构造最小 UIMessage（仅文本 part） */
function makeMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text }],
  } as UIMessage;
}

describe('findMessageMatches', () => {
  const messages = [
    makeMessage('m1', '修复了登录 bug'),
    makeMessage('m2', 'Add unit tests for search'),
    makeMessage('m3', '搜索功能实现完成'),
  ];

  it('空查询返回空列表', () => {
    expect(findMessageMatches(messages, '')).toEqual([]);
    expect(findMessageMatches(messages, '   ')).toEqual([]);
  });

  it('大小写不敏感匹配', () => {
    expect(findMessageMatches(messages, 'SEARCH')).toEqual([1]);
  });

  it('多匹配返回全部索引', () => {
    expect(findMessageMatches(messages, '搜索')).toEqual([2]);
    expect(findMessageMatches(messages, 'bug')).toEqual([0]);
  });

  it('无匹配返回空列表', () => {
    expect(findMessageMatches(messages, '不存在的关键词')).toEqual([]);
  });

  it('空消息列表返回空', () => {
    expect(findMessageMatches([], 'x')).toEqual([]);
  });
});
