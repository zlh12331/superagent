// src/main/infra/im/adapters/feishu-stream.test.ts
// 飞书事件解析单测：im.message.receive_v1 → 入站消息（纯函数）

import { describe, expect, it } from 'vitest';
import { type FeishuMessageEventV1, parseFeishuEvent } from './feishu-stream';

/** 构造飞书文本消息事件 */
function textEvent(
  content: string,
  overrides?: Partial<FeishuMessageEventV1['message']>,
): FeishuMessageEventV1 {
  return {
    sender: { sender_id: { open_id: 'ou-123' }, sender_type: 'user' },
    message: {
      message_id: 'om-1',
      chat_id: 'oc-7',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: content }),
      ...overrides,
    },
    event: { type: 'im.message.receive_v1', event_time: 1700000000000 },
  };
}

describe('parseFeishuEvent（飞书消息事件解析）', () => {
  it('text 消息：完整解析为入站消息', () => {
    const parsed = parseFeishuEvent(textEvent('帮我检查构建'));
    expect(parsed).toEqual({
      text: '帮我检查构建',
      chatId: 'oc-7',
      senderId: 'ou-123',
      messageId: 'om-1',
      timestamp: 1700000000000,
    });
  });

  it('群聊 @bot 前缀剥离', () => {
    const parsed = parseFeishuEvent(textEvent('@_user_1 帮我看看报错'));
    expect(parsed?.text).toBe('帮我看看报错');
  });

  it('post 富文本：拼接文本节点', () => {
    const event = textEvent('x', {
      message_type: 'post',
      content: JSON.stringify({
        content: [
          [
            { tag: 'text', text: '第一段' },
            { tag: 'text', text: '第二段' },
          ],
          [{ tag: 'a', href: 'https://x', text: '链接' }],
        ],
      }),
    });
    const parsed = parseFeishuEvent(event);
    expect(parsed?.text).toBe('第一段第二段');
  });

  it('图片/文件消息：返回 null', () => {
    const event = textEvent('', { message_type: 'image', content: '{"image_key":"img_v2_1"}' });
    expect(parseFeishuEvent(event)).toBeNull();
  });

  it('空文本：返回 null', () => {
    expect(parseFeishuEvent(textEvent('   '))).toBeNull();
  });

  it('缺 message：返回 null（容错）', () => {
    expect(parseFeishuEvent({ event: { type: 'im.message.receive_v1' } })).toBeNull();
  });

  it('content 非法 JSON：返回 null（容错）', () => {
    expect(parseFeishuEvent(textEvent('x', { content: 'not-json' }))).toBeNull();
  });

  it('仅 @bot 无内容：返回 null', () => {
    expect(parseFeishuEvent(textEvent('@_user_1'))).toBeNull();
  });
});
