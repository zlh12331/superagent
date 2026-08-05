// src/main/infra/im/adapters/dingtalk-stream.test.ts
// 钉钉 Stream 事件解析单测：事件帧 → 入站消息（纯函数，无网络）

import { describe, expect, it } from 'vitest';
import { type DingTalkEventFrame, parseDingTalkEvent } from './dingtalk-stream';

/** 构造文本消息事件帧（钉钉 chatbot 形状） */
function textFrame(overrides?: Partial<DingTalkEventFrame['body']>): DingTalkEventFrame {
  return {
    type: 'data',
    headers: { topic: '/v1.0/im/bot/messages/get' },
    body: {
      eventType: 'ChatbotMessage',
      eventId: 'event-1',
      eventBornTime: 1700000000000,
      data: {
        senderStaffId: 'staff-42',
        conversationId: 'cid-7',
        msgId: 'msg-9',
        msgtype: 'text',
        text: { content: '帮我重构模块 A' },
      },
      ...overrides,
    },
  };
}

describe('parseDingTalkEvent（钉钉 Stream 事件解析）', () => {
  it('文本消息：完整解析为入站消息', () => {
    const parsed = parseDingTalkEvent(textFrame());
    expect(parsed).toEqual({
      text: '帮我重构模块 A',
      chatId: 'cid-7',
      senderId: 'staff-42',
      messageId: 'msg-9',
      timestamp: 1700000000000,
    });
  });

  it('非 data 帧（register/nop）：返回 null', () => {
    expect(parseDingTalkEvent({ type: 'register', headers: {} })).toBeNull();
    expect(parseDingTalkEvent({ type: 'nop' })).toBeNull();
  });

  it('非文本消息（图片/文件）：返回 null', () => {
    const frame = textFrame();
    const body = frame.body as { data: Record<string, unknown> };
    body.data = { msgtype: 'picture', conversationId: 'cid-7', msgId: 'm1' };
    expect(parseDingTalkEvent(frame)).toBeNull();
  });

  it('空文本：返回 null', () => {
    const frame = textFrame();
    const body = frame.body as { data: Record<string, unknown> };
    body.data = { msgtype: 'text', conversationId: 'cid-7', text: { content: '   ' } };
    expect(parseDingTalkEvent(frame)).toBeNull();
  });

  it('缺 data：返回 null（容错）', () => {
    expect(parseDingTalkEvent({ type: 'data', body: { eventType: 'X' } })).toBeNull();
  });

  it('未知事件类型（审批/成员事件）：返回 null', () => {
    const frame = textFrame();
    const body = frame.body as { eventType: string };
    body.eventType = 'ApprovalFinished';
    expect(parseDingTalkEvent(frame)).toBeNull();
  });
});
