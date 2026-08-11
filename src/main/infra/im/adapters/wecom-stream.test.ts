// src/main/infra/im/adapters/wecom-stream.test.ts
// 企业微信消息帧解析单测：aibot payload → 入站消息（纯函数）

import { describe, expect, it } from 'vitest';
import { parseWecomEvent } from './wecom-stream';

/** 构造企业微信文本消息帧 */
function textFrame(content: string, overrides?: Record<string, unknown>): unknown {
  return {
    body: {
      msgid: 'msg-1',
      from: { userid: 'user-42' },
      chattype: 'single',
      chatid: 'chat-7',
      msgtype: 'text',
      text: { content },
      ...overrides,
    },
  };
}

describe('parseWecomEvent（企业微信消息帧解析）', () => {
  it('text 消息：完整解析为入站消息', () => {
    const parsed = parseWecomEvent(textFrame('帮我部署'));
    expect(parsed).toMatchObject({
      text: '帮我部署',
      chatId: 'chat-7',
      senderId: 'user-42',
      messageId: 'msg-1',
    });
    expect(parsed?.timestamp).toBeGreaterThan(0);
  });

  it('群聊：chatid 优先（chattype=group）', () => {
    const parsed = parseWecomEvent(textFrame('群消息', { chattype: 'group' }));
    expect(parsed?.chatId).toBe('chat-7');
  });

  it('单聊无 chatid：chatId 回退 senderId', () => {
    const parsed = parseWecomEvent(textFrame('私聊', { chatid: '' }));
    expect(parsed?.chatId).toBe('user-42');
  });

  it('语音消息：取语音转文本', () => {
    const parsed = parseWecomEvent(
      textFrame('x', { text: undefined, msgtype: 'voice', voice: { content: '语音转文字内容' } }),
    );
    expect(parsed?.text).toBe('语音转文字内容');
  });

  it('mixed 图文混排：拼接文本项', () => {
    const parsed = parseWecomEvent(
      textFrame('x', {
        text: undefined,
        msgtype: 'mixed',
        mixed: {
          msg_item: [
            { msgtype: 'text', text: { content: '第一段' } },
            { msgtype: 'text', text: { content: '第二段' } },
          ],
        },
      }),
    );
    expect(parsed?.text).toBe('第一段\n第二段');
  });

  it('图片消息：媒体占位（agent 可感知）', () => {
    const parsed = parseWecomEvent(textFrame('x', { text: undefined, msgtype: 'image' }));
    expect(parsed?.text).toBe('(image)');
  });

  it('文件消息：占位含文件名', () => {
    const parsed = parseWecomEvent(
      textFrame('x', { text: undefined, msgtype: 'file', file: { filename: '报告.pdf' } }),
    );
    expect(parsed?.text).toBe('(file: 报告.pdf)');
  });

  it('缺 senderId：返回 null', () => {
    expect(
      parseWecomEvent({ body: { msgid: 'm1', chatid: 'c1', text: { content: 'x' } } }),
    ).toBeNull();
  });

  it('无文本无媒体：返回 null', () => {
    expect(parseWecomEvent(textFrame('x', { msgtype: 'text', text: { content: '' } }))).toBeNull();
  });

  it('payload 非对象：返回 null（容错）', () => {
    expect(parseWecomEvent('not-object')).toBeNull();
  });
});

describe('parseWecomEvent 补充（媒体占位与兜底）', () => {
  it('voice 消息：语音转文本', () => {
    const parsed = parseWecomEvent({
      body: {
        msgid: 'm1',
        from: { userid: 'u1' },
        chattype: 'single',
        chatid: 'c1',
        msgtype: 'voice',
        voice: { content: '语音转文字' },
      },
    });
    expect(parsed?.text).toBe('语音转文字');
  });

  it('video 消息：媒体占位 (video)', () => {
    const parsed = parseWecomEvent({
      body: {
        msgid: 'm1',
        from: { userid: 'u1' },
        chattype: 'single',
        chatid: 'c1',
        msgtype: 'video',
      },
    });
    expect(parsed?.text).toBe('(video)');
  });

  it('file 消息无 filename：占位 (file: file)', () => {
    const parsed = parseWecomEvent({
      body: {
        msgid: 'm1',
        from: { userid: 'u1' },
        chattype: 'single',
        chatid: 'c1',
        msgtype: 'file',
        file: {},
      },
    });
    expect(parsed?.text).toBe('(file: file)');
  });

  it('缺 msgid：messageId 兜底为 chatId:timestamp 格式', () => {
    const parsed = parseWecomEvent({
      body: {
        from: { userid: 'u1' },
        chattype: 'single',
        chatid: 'c1',
        msgtype: 'text',
        text: { content: 'hi' },
      },
    });
    expect(parsed?.messageId.startsWith('c1:')).toBe(true);
  });

  it('mixed 含非 record item：跳过不崩溃', () => {
    const parsed = parseWecomEvent({
      body: {
        msgid: 'm1',
        from: { userid: 'u1' },
        chattype: 'single',
        chatid: 'c1',
        msgtype: 'mixed',
        mixed: { msg_item: ['not-object', { msgtype: 'text', text: { content: 'ok' } }] },
      },
    });
    expect(parsed?.text).toBe('ok');
  });

  it('缺 body：返回 null', () => {
    expect(parseWecomEvent({ other: 1 })).toBeNull();
  });
});
