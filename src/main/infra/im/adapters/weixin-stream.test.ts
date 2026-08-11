// src/main/infra/im/adapters/weixin-stream.test.ts
// 微信消息单测：iLink 消息解析（纯函数）+ getupdates 协议（本地 HTTP 注入）

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fetchWeixinUpdates,
  parseWeixinMessage,
  sendWeixinText,
  type WeixinMessage,
} from './weixin-stream';

/** 构造 iLink 文本消息 */
function textMessage(text: string, overrides?: Partial<WeixinMessage>): WeixinMessage {
  return {
    message_id: 101,
    from_user_id: 'wx-user-1',
    create_time_ms: 1700000000000,
    context_token: 'ctx-9',
    item_list: [{ type: 1, text_item: { text } }],
    ...overrides,
  };
}

describe('parseWeixinMessage（iLink 消息解析）', () => {
  it('文本消息：完整解析为入站消息', () => {
    const parsed = parseWeixinMessage(textMessage('帮我发个消息'));
    expect(parsed).toMatchObject({
      text: '帮我发个消息',
      chatId: 'wx-user-1',
      senderId: 'wx-user-1',
      messageId: '101',
      contextToken: 'ctx-9',
    });
    expect(parsed?.timestamp).toBe(1700000000000);
  });

  it('语音消息：取语音转文字', () => {
    const parsed = parseWeixinMessage(
      textMessage('x', { item_list: [{ type: 3, voice_item: { text: '语音内容' } }] }),
    );
    expect(parsed?.text).toBe('语音内容');
  });

  it('多文本项拼接', () => {
    const parsed = parseWeixinMessage(
      textMessage('x', {
        item_list: [
          { type: 1, text_item: { text: '第一段' } },
          { type: 1, text_item: { text: '第二段' } },
        ],
      }),
    );
    expect(parsed?.text).toBe('第一段第二段');
  });

  it('无文本（纯图片消息）：返回 null', () => {
    expect(parseWeixinMessage(textMessage('x', { item_list: [] }))).toBeNull();
  });

  it('缺 from_user_id：返回 null', () => {
    expect(parseWeixinMessage(textMessage('x', { from_user_id: '' }))).toBeNull();
  });
});

describe('fetchWeixinUpdates（getupdates 协议）', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  async function startServer(handler: (body: unknown) => unknown): Promise<string> {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      req.on('end', () => {
        const result = handler(data.length > 0 ? JSON.parse(data) : null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('服务器启动失败');
    }
    return `http://127.0.0.1:${address.port}`;
  }

  it('getupdates：返回消息列表 + 游标续传', async () => {
    const baseUrl = await startServer((body) => {
      const req = body as { get_updates_buf?: string; base_info?: { channel_version?: string } };
      expect(req.base_info?.channel_version).toBe('2.1.3');
      expect(req.get_updates_buf).toBe('cursor-1');
      return {
        ret: 0,
        msgs: [
          {
            message_id: 1,
            from_user_id: 'u1',
            item_list: [{ type: 1, text_item: { text: '你好' } }],
          },
        ],
        get_updates_buf: 'cursor-2',
      };
    });
    const response = await fetchWeixinUpdates({
      baseUrl,
      token: 'tok-1',
      cursor: 'cursor-1',
      timeoutMs: 10_000,
      signal: new AbortController().signal,
    });
    expect(response.get_updates_buf).toBe('cursor-2');
    expect(response.msgs).toHaveLength(1);
  });

  it('sendmsg：发送文本消息（携带 context_token）', async () => {
    const captured: Array<{ body: unknown; auth: string | undefined }> = [];
    const baseUrl = await startServer((body) => {
      captured.push({ body, auth: undefined });
      return { ret: 0 };
    });
    await sendWeixinText({
      baseUrl,
      token: 'tok-1',
      toUserId: 'wx-user-1',
      text: '回复内容',
      contextToken: 'ctx-9',
    });
    const req = captured[0]?.body as Record<string, unknown>;
    expect(req['to_user_id']).toBe('wx-user-1');
    expect(req['context_token']).toBe('ctx-9');
    const items = req['item_list'] as Array<{ type: number; text_item?: { text?: string } }>;
    expect(items[0]?.text_item?.text).toBe('回复内容');
  });
});
