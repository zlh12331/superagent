// src/main/infra/im/adapters/webhook-channels.test.ts
// Webhook 渠道单测：真实本地 HTTP 服务器接收 POST（无 mock 框架）

import { createServer, type Server } from 'node:http';
import { ErrorCode } from '@code-agent/shared/main';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DingTalkAdapter } from '../../src/main/infra/im/adapters/dingtalk-adapter';
import { FeishuAdapter } from '../../src/main/infra/im/adapters/feishu-adapter';
import { dingtalkSign } from '../../src/main/infra/im/adapters/webhook-channel';
import { WecomAdapter } from '../../src/main/infra/im/adapters/wecom-adapter';
import type { ChannelTarget } from '../../src/main/infra/im/channel/types';

interface CapturedRequest {
  readonly path: string;
  readonly body: unknown;
  readonly headers: Record<string, string>;
}

/** 本地 HTTP 服务器捕获 webhook POST（返回钉钉风格 0 成功体） */
async function startCaptureServer(): Promise<{
  server: Server;
  url: string;
  captured: CapturedRequest[];
}> {
  const captured: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
    });
    req.on('end', () => {
      captured.push({
        path: req.url ?? '',
        body: data.length > 0 ? JSON.parse(data) : null,
        headers: req.headers as Record<string, string>,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          errcode: 0,
          errmsg: 'ok',
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('服务器启动失败');
  }
  return { server, url: `http://127.0.0.1:${address.port}/robot/send`, captured };
}

describe('Webhook 渠道适配器', () => {
  let server: Server | null = null;

  beforeEach(() => {
    server = null;
  });

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  });

  const target: ChannelTarget = { chatId: 'group' };

  it('钉钉：markdown payload + 发送成功', async () => {
    const env = await startCaptureServer();
    server = env.server;

    const adapter = new DingTalkAdapter();
    await adapter.connect(env.url);
    await adapter.sendMessage(target, '**任务完成**：模块 A 重构结束');

    expect(env.captured).toHaveLength(1);
    const request = env.captured[0];
    expect(request?.path).toContain('/robot/send');
    expect(request?.body).toEqual({
      msgtype: 'markdown',
      markdown: { title: 'Code Agent 消息', text: '**任务完成**：模块 A 重构结束' },
    });
  });

  it('钉钉：加签（URL#secret）追加 timestamp + sign', async () => {
    const env = await startCaptureServer();
    server = env.server;

    const adapter = new DingTalkAdapter();
    await adapter.connect(`${env.url}#my-secret`);
    await adapter.sendMessage(target, '加签消息');

    expect(env.captured).toHaveLength(1);
    const path = env.captured[0]?.path ?? '';
    expect(path).toContain('timestamp=');
    expect(path).toContain('sign=');
    // 签名可独立验证（HMAC-SHA256 base64）
    const timestamp = Number(/timestamp=(\d+)/.exec(path)?.[1]);
    expect(timestamp).toBeGreaterThan(0);
    const expectedSign = await dingtalkSign('my-secret', timestamp);
    expect(decodeURIComponent(/sign=([^&]+)/.exec(path)?.[1] ?? '')).toBe(expectedSign);
  });

  it('企业微信：markdown content payload', async () => {
    const env = await startCaptureServer();
    server = env.server;

    const adapter = new WecomAdapter();
    await adapter.connect(env.url);
    await adapter.sendMessage(target, '构建完成：exit 0');

    expect(env.captured).toHaveLength(1);
    expect(env.captured[0]?.body).toEqual({
      msgtype: 'markdown',
      markdown: { content: '构建完成：exit 0' },
    });
  });

  it('飞书：msg_type markdown payload', async () => {
    const env = await startCaptureServer();
    server = env.server;

    const adapter = new FeishuAdapter();
    await adapter.connect(env.url);
    await adapter.sendMessage(target, '请确认审批');

    expect(env.captured).toHaveLength(1);
    expect(env.captured[0]?.body).toEqual({
      ['msg_type']: 'markdown',
      content: { text: '请确认审批' },
    });
  });

  it('未连接发送：抛 NOT_CONFIGURED', async () => {
    const adapter = new DingTalkAdapter();
    await expect(adapter.sendMessage(target, 'x')).rejects.toThrow('未配置');
  });

  it('无效 token：抛 INVALID_TOKEN', async () => {
    const adapter = new WecomAdapter();
    await expect(adapter.connect('not-a-url')).rejects.toThrow('无效');
  });

  it('渠道错误响应（非 0 errcode）：发送失败并分类', async () => {
    // 返回渠道错误的服务器
    const captured: CapturedRequest[] = [];
    const errorServer = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        captured.push({ path: req.url ?? '', body: null, headers: {} });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            errcode: 310000,
            errmsg: 'keywords not in content',
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      errorServer.listen(0, '127.0.0.1', () => resolve());
    });
    server = errorServer;
    const address = errorServer.address();
    if (address === null || typeof address === 'string') {
      throw new Error('服务器启动失败');
    }
    const adapter = new DingTalkAdapter();
    await adapter.connect(`http://127.0.0.1:${address.port}/send`);
    await expect(adapter.sendMessage(target, '消息')).rejects.toThrow('渠道错误');
  });
});

describe('Webhook token 解析补充', () => {
  it('token 带 # 但 secret 为空：连接成功（secret=null）', async () => {
    const adapter = new DingTalkAdapter();
    await expect(adapter.connect('http://127.0.0.1:1/hook#')).resolves.toBeUndefined();
  });

  it('token 协议非 http/https（ftp）→ INVALID_TOKEN', async () => {
    const adapter = new DingTalkAdapter();
    await expect(adapter.connect('ftp://x.com/hook')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });

  it('token 非法 URL → INVALID_TOKEN', async () => {
    const adapter = new DingTalkAdapter();
    await expect(adapter.connect('not-a-url')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });
});
