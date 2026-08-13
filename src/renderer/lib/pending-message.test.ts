// src/renderer/lib/pending-message.test.ts
// 欢迎页首条消息透传辅助单测（含陈旧性防护）

import { describe, expect, it } from 'vitest';

import {
  consumePendingMessage,
  PENDING_MESSAGE_TTL_MS,
  pendingMessageKey,
} from './pending-message';

/** 内存 Map 实现的 Storage 桩（jsdom 外安全，避免环境耦合） */
function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  } as unknown as Storage;
}

/** 构造有效暂存消息（fresh = 当前时间；stale = 超过 TTL） */
function write(storage: Storage, sessionId: string, text: string, createdAt: number): void {
  storage.setItem(pendingMessageKey(sessionId), JSON.stringify({ text, createdAt }));
}

describe('pending-message', () => {
  it('key 以固定前缀 + sessionId 组成', () => {
    expect(pendingMessageKey('s-1')).toBe('welcome:pending-message:s-1');
  });

  it('消费暂存消息：返回 trim 后文本并移除存储', () => {
    const storage = createMemoryStorage();
    write(storage, 's-1', '  你好，请分析项目  ', Date.now());
    const text = consumePendingMessage(storage, 's-1');
    expect(text).toBe('你好，请分析项目');
    expect(storage.getItem(pendingMessageKey('s-1'))).toBeNull();
  });

  it('消费是幂等的：第二次读取返回 null', () => {
    const storage = createMemoryStorage();
    write(storage, 's-1', 'hi', Date.now());
    expect(consumePendingMessage(storage, 's-1')).toBe('hi');
    expect(consumePendingMessage(storage, 's-1')).toBeNull();
  });

  it('陈旧消息（超过 TTL / 缺 createdAt）：丢弃不发送', () => {
    const stale = createMemoryStorage();
    write(stale, 's-1', '陈旧消息', Date.now() - PENDING_MESSAGE_TTL_MS - 1000);
    expect(consumePendingMessage(stale, 's-1')).toBeNull();
    expect(stale.getItem(pendingMessageKey('s-1'))).toBeNull();

    const noTimestamp = createMemoryStorage();
    noTimestamp.setItem(pendingMessageKey('s-1'), JSON.stringify({ text: '无时间戳' }));
    expect(consumePendingMessage(noTimestamp, 's-1')).toBeNull();
  });

  it('key 不存在：返回 null 且不抛错', () => {
    expect(consumePendingMessage(createMemoryStorage(), 's-none')).toBeNull();
  });

  it('坏 JSON / 空文本 / 形状不符：丢弃且不抛错', () => {
    const bad = createMemoryStorage();
    bad.setItem(pendingMessageKey('s-1'), '{oops');
    expect(consumePendingMessage(bad, 's-1')).toBeNull();

    const empty = createMemoryStorage();
    write(empty, 's-1', '   ', Date.now());
    expect(consumePendingMessage(empty, 's-1')).toBeNull();

    const wrongShape = createMemoryStorage();
    wrongShape.setItem(pendingMessageKey('s-1'), JSON.stringify({ nope: 1 }));
    expect(consumePendingMessage(wrongShape, 's-1')).toBeNull();
  });
});
