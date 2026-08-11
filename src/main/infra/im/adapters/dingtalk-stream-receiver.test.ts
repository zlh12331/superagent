// src/main/infra/im/adapters/dingtalk-stream-receiver.test.ts
// DingTalkStreamReceiver 单测：钉钉 Stream 长连接生命周期（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - fetchFn / WebSocketCtor / timeoutMs / heartbeatMs 经构造注入
// - FakeWebSocket 可编程触发 open/message/error/close 事件
// - 心跳间隔注入 10ms 验证 nop 帧发送（生产 30s 不可等待）
// ──────────────────────────────────────────────────────────────

import { ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import { DingTalkStreamReceiver } from './dingtalk-stream';

/** 可编程 WebSocket 桩：捕获事件监听，测试手动触发 */
class FakeWebSocket {
  readonly url: string;
  readonly send = vi.fn();
  readonly close = vi.fn();
  private readonly listeners = new Map<string, Set<(event?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, cb: (event?: unknown) => void): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(cb);
  }

  emit(type: string, event?: unknown): void {
    for (const cb of this.listeners.get(type) ?? []) {
      cb(event);
    }
  }

  hasListener(type: string): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }
}

/** 当前测试的共享 WS 实例（SharedWebSocketCtor 构造返回它） */
let currentWs: FakeWebSocket;

/** 测试桩：new 返回共享 WS 实例（open 的异步链中构造，需保持同一对象） */
class SharedWebSocketCtor {
  constructor(url: string) {
    // 同步更新 url（endpoint 在异步链中才确定）
    currentWs.url = url;
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return currentWs;
  }
}

/** 按 URL 分发的 fake fetch（POST accessToken / GET gateway） */
function makeFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.includes('/accessToken')) {
      return { json: async () => ({ accessToken: 'tok-1' }) };
    }
    if (url.includes('/connections/open')) {
      return {
        json: async () => ({ data: [{ endpoint: 'wss://gw.dingtalk.com', ticket: 't-1' }] }),
      };
    }
    return { json: async () => ({}) };
  });
}

function makeReceiver(
  options: { fetchFn?: ReturnType<typeof vi.fn>; timeoutMs?: number; heartbeatMs?: number } = {},
): {
  receiver: DingTalkStreamReceiver;
  fetchFn: ReturnType<typeof vi.fn>;
  ws: FakeWebSocket;
} {
  const fetchFn = options.fetchFn ?? makeFetch();
  const ws = new FakeWebSocket('wss://pending');
  currentWs = ws;
  const receiver = new DingTalkStreamReceiver(
    { appKey: 'k', appSecret: 's' },
    {
      fetchFn: fetchFn as unknown as typeof fetch,
      WebSocketCtor: SharedWebSocketCtor as unknown as typeof WebSocket,
      timeoutMs: options.timeoutMs ?? 500,
      heartbeatMs: options.heartbeatMs ?? 10,
    },
  );
  return { receiver, fetchFn, ws };
}

/** 构造合法 ChatbotMessage data 帧 */
function chatbotFrame(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: 'data',
    body: {
      eventType: 'ChatbotMessage',
      eventId: 'evt-1',
      eventBornTime: 1700000000000,
      data: {
        msgtype: 'text',
        senderStaffId: 'staff-1',
        conversationId: 'conv-1',
        text: { content: '你好' },
        msgId: 'msg-1',
      },
      ...overrides,
    },
  };
}

describe('DingTalkStreamReceiver.open（三件套）', () => {
  it('正向：完整流程——token → 网关 → WS 构造 + register 发送 + resolve', async () => {
    const { receiver, fetchFn, ws } = makeReceiver();
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('open')).toBe(true));
    ws.emit('open');
    await p;
    // token + gateway 两个 HTTP 调用完成
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(ws.url).toBe('wss://gw.dingtalk.com');
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'register', ticket: 't-1' }));
  });

  it('正向：registered 帧 → isOpen=true + 心跳启动（nop 帧定期发送）', async () => {
    const { receiver, ws } = makeReceiver({ heartbeatMs: 10 });
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('open')).toBe(true));
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'registered' }) });
    await p;
    expect(receiver.isOpen).toBe(true);
    // 心跳：10ms 间隔，等 25ms 应至少发送 1 次 nop
    await new Promise((resolve) => setTimeout(resolve, 25));
    const nopCalls = ws.send.mock.calls.filter((c) => String(c[0]).includes('"nop"'));
    expect(nopCalls.length).toBeGreaterThanOrEqual(1);
    receiver.close();
  });

  it('正向：data 帧（ChatbotMessage）→ 解析后转发给订阅者', async () => {
    const { receiver, ws } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('open')).toBe(true));
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify(chatbotFrame()) });
    await p;
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'dingtalk',
        chatId: 'conv-1',
        text: '你好',
        messageId: 'msg-1',
      }),
    );
    receiver.close();
  });

  it('边界：已 open 时重复调用 → no-op（HTTP 不再请求）', async () => {
    const { receiver, fetchFn, ws } = makeReceiver();
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('open')).toBe(true));
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'registered' }) });
    await p;
    expect(receiver.isOpen).toBe(true);
    const callsBefore = fetchFn.mock.calls.length;
    await receiver.open();
    expect(fetchFn.mock.calls.length).toBe(callsBefore);
    receiver.close();
  });

  it('异常：accessToken 缺失 → INVALID_TOKEN', async () => {
    const badFetch = vi.fn(async () => ({ json: async () => ({ code: 401, message: 'bad key' }) }));
    const { receiver } = makeReceiver({ fetchFn: badFetch });
    await expect(receiver.open()).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });

  it('异常：gateway 响应无 data[0] → REQUEST_FAILED', async () => {
    const badFetch = vi.fn(async (url: string) => {
      if (url.includes('/accessToken')) {
        return { json: async () => ({ accessToken: 'tok' }) };
      }
      return { json: async () => ({ code: 500 }) };
    });
    const { receiver } = makeReceiver({ fetchFn: badFetch });
    await expect(receiver.open()).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_REQUEST_FAILED,
    });
  });

  it('异常：WS error 事件 → REQUEST_FAILED', async () => {
    const { receiver, ws } = makeReceiver();
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('error')).toBe(true));
    ws.emit('error', new Error('ws down'));
    await expect(p).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_REQUEST_FAILED,
    });
    expect(receiver.isOpen).toBe(false);
  });

  it('异常：WS 连接超时（无 open/error）→ REQUEST_FAILED', async () => {
    const { receiver } = makeReceiver({ timeoutMs: 30 });
    const p = receiver.open();
    await expect(p).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_REQUEST_FAILED,
    });
  });
});

describe('DingTalkStreamReceiver.close', () => {
  it('正向：关闭 → 心跳清除 + ws.close + isOpen=false', async () => {
    const { receiver, ws } = makeReceiver({ heartbeatMs: 10 });
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('open')).toBe(true));
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'registered' }) });
    await p;
    receiver.close();
    expect(ws.close).toHaveBeenCalled();
    expect(receiver.isOpen).toBe(false);
  });

  it('边界：未 open 时 close → no-op 不抛', () => {
    const { receiver } = makeReceiver();
    expect(() => receiver.close()).not.toThrow();
  });

  it('边界：close 后心跳停止（nop 不再发送）', async () => {
    const { receiver, ws } = makeReceiver({ heartbeatMs: 10 });
    const p = receiver.open();
    await vi.waitFor(() => expect(ws.hasListener('open')).toBe(true));
    ws.emit('open');
    ws.emit('message', { data: JSON.stringify({ type: 'registered' }) });
    await p;
    receiver.close();
    const callsAfterClose = ws.send.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(ws.send.mock.calls.length).toBe(callsAfterClose);
  });
});
