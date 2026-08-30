// src/renderer/lib/pending-message.test.ts
// 欢迎页首条消息透传解析规则单测（含陈旧性防护）

import { describe, expect, it } from 'vitest';

import { PENDING_MESSAGE_TTL_MS, resolvePendingMessage } from './pending-message';

describe('resolvePendingMessage', () => {
  it('有效记录：返回 trim 后文本', () => {
    expect(
      resolvePendingMessage({ text: '  你好，请分析项目  ', createdAt: Date.now() }, Date.now()),
    ).toBe('你好，请分析项目');
  });

  it('无记录：返回 null', () => {
    expect(resolvePendingMessage(undefined, Date.now())).toBeNull();
  });

  it('陈旧记录（超过 TTL）：丢弃不发送', () => {
    const now = Date.now();
    expect(
      resolvePendingMessage({ text: '陈旧消息', createdAt: now - PENDING_MESSAGE_TTL_MS - 1 }, now),
    ).toBeNull();
  });

  it('TTL 边界内（恰好等于 TTL）：仍然发送', () => {
    const now = Date.now();
    expect(
      resolvePendingMessage({ text: '刚好到期前', createdAt: now - PENDING_MESSAGE_TTL_MS }, now),
    ).toBe('刚好到期前');
  });

  it('空 / 纯空白文本：返回 null', () => {
    const now = Date.now();
    expect(resolvePendingMessage({ text: '', createdAt: now }, now)).toBeNull();
    expect(resolvePendingMessage({ text: '   \n ', createdAt: now }, now)).toBeNull();
  });
});
