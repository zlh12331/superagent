// src/renderer/stores/transient/pending-message-store.test.ts
// 首条消息暂存 store：消费恰好一次 + 过期规则 + 会话隔离

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PENDING_MESSAGE_TTL_MS } from '@/lib/pending-message';

import { usePendingMessageStore } from './pending-message-store';

describe('pending-message-store', () => {
  beforeEach(() => {
    usePendingMessageStore.setState({ records: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('暂存后消费恰好一次：第二次消费返回 null 且记录被清空', () => {
    usePendingMessageStore.getState().stash('s-1', '  帮我重构这个模块  ');
    expect(usePendingMessageStore.getState().consume('s-1')).toBe('帮我重构这个模块');
    expect(usePendingMessageStore.getState().consume('s-1')).toBeNull();
    expect(usePendingMessageStore.getState().records).toEqual({});
  });

  it('重复消费不会再次发送（StrictMode 双挂载场景）', () => {
    usePendingMessageStore.getState().stash('s-1', 'hi');
    const sent: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const text = usePendingMessageStore.getState().consume('s-1');
      if (text !== null) sent.push(text);
    }
    expect(sent).toEqual(['hi']);
  });

  it('空文本暂存后消费为 null（不自动发送空气泡）', () => {
    usePendingMessageStore.getState().stash('s-1', '   ');
    expect(usePendingMessageStore.getState().consume('s-1')).toBeNull();
    expect(usePendingMessageStore.getState().records).toEqual({});
  });

  it('未暂存的会话：消费返回 null', () => {
    expect(usePendingMessageStore.getState().consume('nope')).toBeNull();
  });

  it('会话隔离：消费 s-1 不影响 s-2 的暂存', () => {
    usePendingMessageStore.getState().stash('s-1', '第一条');
    usePendingMessageStore.getState().stash('s-2', '第二条');
    expect(usePendingMessageStore.getState().consume('s-1')).toBe('第一条');
    expect(usePendingMessageStore.getState().consume('s-2')).toBe('第二条');
  });

  it('同会话重复暂存：以最后一次为准', () => {
    usePendingMessageStore.getState().stash('s-1', '旧内容');
    usePendingMessageStore.getState().stash('s-1', '新内容');
    expect(usePendingMessageStore.getState().consume('s-1')).toBe('新内容');
  });

  it('超过 TTL 的暂存：消费时丢弃并清除记录', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_700_000_000_000));
    usePendingMessageStore.getState().stash('s-1', '陈旧消息');
    vi.setSystemTime(new Date(1_700_000_000_000 + PENDING_MESSAGE_TTL_MS + 1));

    expect(usePendingMessageStore.getState().consume('s-1')).toBeNull();
    expect(usePendingMessageStore.getState().records).toEqual({});
  });
});
