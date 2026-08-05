// src/main/infra/im/adapters/qq-stream.test.ts
// QQ 消息解析单测：Gateway 帧 → 入站消息 + access_token 获取（本地 HTTP 注入）

import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchQqAccessToken, parseQqEvent, type QqGatewayFrame, QqOpCode } from './qq-stream';

/** 构造 Gateway 帧 */
function frame(t: string, d: unknown): QqGatewayFrame {
  return { op: QqOpCode.DISPATCH, t, d, s: 1 };
}

describe('parseQqEvent（QQ Gateway 事件解析）', () => {
  it('群聊 @ 消息：完整解析（group_openid 为 chatId）', () => {
    const parsed = parseQqEvent(
      frame('GROUP_AT_MESSAGE', {
        id: 'evt-1',
        author: { member_openid: 'member-9' },
        content: '<@!bot_openid> 帮我看看',
        group_openid: 'group-3',
      }),
    );
    expect(parsed).toMatchObject({
      chatType: 'group',
      text: '帮我看看',
      chatId: 'group-3',
      senderId: 'member-9',
      messageId: 'evt-1',
    });
  });

  it('C2C 单聊：user_openid 为 chatId', () => {
    const parsed = parseQqEvent(
      frame('C2C_MESSAGE', {
        id: 'evt-2',
        author: { user_openid: 'user-5' },
        content: '在吗',
      }),
    );
    expect(parsed).toMatchObject({
      chatType: 'user',
      text: '在吗',
      chatId: 'user-5',
      senderId: 'user-5',
    });
  });

  it('群聊消息保留非 bot mention（仅剥离开头 @bot）', () => {
    const parsed = parseQqEvent(
      frame('GROUP_AT_MESSAGE', {
        id: 'evt-3',
        author: { member_openid: 'm1' },
        content: '<@!botid> @member2 一起确认',
        group_openid: 'g1',
      }),
    );
    expect(parsed?.text).toBe('@member2 一起确认');
  });

  it('非消息事件（READY/心跳）：返回 null', () => {
    expect(parseQqEvent(frame('READY', { user: {} }))).toBeNull();
    expect(parseQqEvent({ op: QqOpCode.HELLO, d: { heartbeat_interval: 30000 } })).toBeNull();
  });

  it('空文本：返回 null', () => {
    expect(
      parseQqEvent(frame('C2C_MESSAGE', { id: 'x', author: { user_openid: 'u' }, content: '  ' })),
    ).toBeNull();
  });

  it('非 op0 帧：返回 null（容错）', () => {
    expect(parseQqEvent({ op: 1, d: null })).toBeNull();
  });
});

describe('fetchQqAccessToken（access_token 获取）', () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  it('成功：解析 access_token + expires_in', async () => {
    const captured: Array<{ body: unknown; headers: Record<string, string> }> = [];
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8');
      });
      req.on('end', () => {
        captured.push({ body: JSON.parse(data), headers: req.headers as Record<string, string> });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'tok-123', expires_in: 7200 }));
      });
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('服务器启动失败');
    }
    const result = await fetchQqAccessToken(
      'app-1',
      'sec-1',
      `http://127.0.0.1:${address.port}/token`,
    );
    expect(result.accessToken).toBe('tok-123');
    expect(result.expiresIn).toBe(7200);
    // 请求体校验（appId/clientSecret 协议形状）
    expect(captured[0]?.body).toEqual({ appId: 'app-1', clientSecret: 'sec-1' });
  });

  it('响应缺 access_token：抛 INVALID_TOKEN', async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 400, message: 'bad appId' }));
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('服务器启动失败');
    }
    await expect(
      fetchQqAccessToken('app-1', 'sec-1', `http://127.0.0.1:${address.port}/token`),
    ).rejects.toThrow('access_token');
  });
});
