// src/main/infra/im/adapters/qq-stream-receiver.test.ts
// QqStreamReceiver 单测：QQ Gateway 协议长连接（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - fetchTokenFn/fetchGatewayFn/WebSocketCtor 经构造注入 fake
// - reconnectDelayMs/handshakeTimeoutMs 注入短值（生产 5s/15s 不可等待）
// - 真实协议帧驱动：HELLO/IDENTIFY/READY/RESUME/INVALID_SESSION/
//   HEARTBEAT/HEARTBEAT_ACK/DISPATCH 全链路
// ──────────────────────────────────────────────────────────────

import { ErrorCode } from '@code-agent/shared/main';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchQqGatewayUrl, QqStreamReceiver } from './qq-stream';

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

/** 当前测试的共享 WS 实例（构造桩返回，open 的异步链中构造） */
let currentWs: FakeWebSocket;

class SharedWebSocketCtor {
  constructor(url: string) {
    // 同步更新 url（endpoint 在异步链中才确定）——WebSocket.url 只读，类型断言绕过
    (currentWs as unknown as { url: string }).url = url;
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return currentWs;
  }
}

/** 协议帧构造 */
const frames = {
  hello: (interval = 20): string => JSON.stringify({ op: 10, d: { heartbeat_interval: interval } }),
  helloAck: (): string => JSON.stringify({ op: 11 }),
  invalidSession: (): string => JSON.stringify({ op: 9 }),
  ready: (sessionId = 'sess-1', seq = 1): string =>
    JSON.stringify({ op: 0, t: 'READY', d: { session_id: sessionId }, s: seq }),
  resumed: (): string => JSON.stringify({ op: 0, t: 'RESUMED', s: 2 }),
  groupAt: (): string =>
    JSON.stringify({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'e1',
        content: '<@botid> 你好',
        group_openid: 'g1',
        author: { member_openid: 'm1' },
      },
      s: 5,
    }),
  c2c: (): string =>
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      d: { id: 'e2', content: '单聊', author: { user_openid: 'u1' } },
      s: 6,
    }),
};

function makeReceiver(
  options: {
    reconnectDelayMs?: number;
    handshakeTimeoutMs?: number;
    fetchTokenFn?: ReturnType<typeof vi.fn>;
    fetchGatewayFn?: ReturnType<typeof vi.fn>;
  } = {},
): {
  receiver: QqStreamReceiver;
  fetchTokenFn: ReturnType<typeof vi.fn>;
  fetchGatewayFn: ReturnType<typeof vi.fn>;
  ws: FakeWebSocket;
} {
  const fetchTokenFn =
    options.fetchTokenFn ?? vi.fn(async () => ({ accessToken: 'tok', expiresIn: 7200 }));
  const fetchGatewayFn = options.fetchGatewayFn ?? vi.fn(async () => 'wss://gw.qq.com');
  currentWs = new FakeWebSocket('wss://pending');
  const receiver = new QqStreamReceiver(
    { appId: 'app', appSecret: 'sec' },
    {
      fetchTokenFn: fetchTokenFn as unknown as typeof import('./qq-stream').fetchQqAccessToken,
      fetchGatewayFn: fetchGatewayFn as unknown as typeof import('./qq-stream').fetchQqGatewayUrl,
      WebSocketCtor: SharedWebSocketCtor as unknown as typeof WebSocket,
      reconnectDelayMs: options.reconnectDelayMs ?? 5,
      handshakeTimeoutMs: options.handshakeTimeoutMs ?? 500,
    },
  );
  return { receiver, fetchTokenFn, fetchGatewayFn, ws: currentWs };
}

/** 等待 WS 监听注册（open 的 fetch 异步链后才构造） */
async function waitWs(ws: FakeWebSocket, type = 'message'): Promise<void> {
  await vi.waitFor(() => expect(ws.hasListener(type)).toBe(true));
}

/** 完成一次完整握手（open → HELLO → identify → READY） */
async function completeHandshake(receiver: QqStreamReceiver, ws: FakeWebSocket): Promise<void> {
  const p = receiver.open();
  await waitWs(ws);
  ws.emit('message', { data: frames.hello() });
  ws.emit('message', { data: frames.ready() });
  await p;
}

describe('QqStreamReceiver.open 握手（三件套）', () => {
  it('正向：完整握手——token → gateway → HELLO → identify(首次) → READY resolve', async () => {
    const { receiver, fetchTokenFn, fetchGatewayFn, ws } = makeReceiver();
    await completeHandshake(receiver, ws);
    expect(fetchTokenFn).toHaveBeenCalledWith(
      'app',
      'sec',
      'https://bots.qq.com/app/getAppAccessToken',
    );
    expect(fetchGatewayFn).toHaveBeenCalledWith('tok', 'https://api.sgroup.qq.com/gateway/bot');
    expect(ws.url).toBe('wss://gw.qq.com');
    expect(receiver.isOpen).toBe(true);
    // identify 帧（首次连接）
    const identifySend = ws.send.mock.calls.find((c) => String(c[0]).includes('"op":2'));
    expect(identifySend).toBeDefined();
    expect(String(identifySend?.[0])).toContain('"token":"QQBot tok"');
    receiver.close();
  });

  it('边界：RESUME 路径——sessionId 已存在（断线重连）→ 发送 RESUME 复用会话', async () => {
    const { receiver, ws } = makeReceiver({ reconnectDelayMs: 5 });
    // 首次握手：READY 记录 sessionId
    await completeHandshake(receiver, ws);
    // 意外断线 → 自动重连 → 第二次握手走 RESUME
    const p = receiver.open(); // opened=false 后可再次 open（reconnect 路径）
    await waitWs(ws);
    ws.emit('message', { data: frames.hello() });
    ws.emit('message', { data: frames.resumed() });
    await p;
    const resumeSend = ws.send.mock.calls.find((c) => String(c[0]).includes('"op":6'));
    expect(resumeSend).toBeDefined();
    expect(String(resumeSend?.[0])).toContain('"session_id":"sess-1"');
    receiver.close();
  });

  it('边界：INVALID_SESSION → 回退 identify（清空 sessionId 走首次流程）', async () => {
    const { receiver, ws } = makeReceiver();
    await completeHandshake(receiver, ws);
    // 重新握手：HELLO → INVALID_SESSION → identify 回退
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello() });
    ws.emit('message', { data: frames.invalidSession() });
    ws.emit('message', { data: frames.ready('sess-new') });
    await p;
    const identifySends = ws.send.mock.calls.filter((c) => String(c[0]).includes('"op":2'));
    expect(identifySends.length).toBeGreaterThanOrEqual(2); // 首次 + 回退
    receiver.close();
  });

  it('异常：fetchToken 失败 → 异常向上抛，isOpen=false', async () => {
    const { receiver } = makeReceiver({
      fetchTokenFn: vi.fn(async () => {
        throw new Error('token http 401');
      }),
    });
    await expect(receiver.open()).rejects.toThrow('token http 401');
    expect(receiver.isOpen).toBe(false);
  });

  it('异常：WS error → REQUEST_FAILED', async () => {
    const { receiver, ws } = makeReceiver();
    const p = receiver.open();
    await waitWs(ws, 'error');
    ws.emit('error', new Error('ws down'));
    await expect(p).rejects.toMatchObject({ code: ErrorCode.IM_CHANNEL_REQUEST_FAILED });
  });

  it('异常：握手超时（无 HELLO）→ REQUEST_FAILED', async () => {
    const { receiver } = makeReceiver({ handshakeTimeoutMs: 30 });
    await expect(receiver.open()).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_REQUEST_FAILED,
    });
  });

  it('边界：重复 open（已 opened）→ no-op', async () => {
    const { receiver, fetchTokenFn, ws } = makeReceiver();
    await completeHandshake(receiver, ws);
    const callsBefore = fetchTokenFn.mock.calls.length;
    await receiver.open();
    expect(fetchTokenFn.mock.calls.length).toBe(callsBefore);
    receiver.close();
  });
});

describe('QqStreamReceiver 心跳与 ack 监控（三件套）', () => {
  it('正向：HELLO 后心跳启动——定期发送 HEARTBEAT(op1) 携带 lastSeq', async () => {
    const { receiver, ws } = makeReceiver();
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello(10) }); // 10ms 心跳
    ws.emit('message', { data: frames.ready('sess-1', 3) }); // 先 ready（seq=3）
    ws.emit('message', { data: frames.groupAt() }); // 后 groupAt（seq=5 覆盖）
    await p;
    // 轮询等待 ≥2 次心跳（10ms 间隔）：固定 35ms 睡眠在 coverage 插桩下会因
    // 定时器漂移只发出 1 次心跳而 flake
    const deadline = Date.now() + 1000;
    while (
      ws.send.mock.calls.filter((c) => String(c[0]).includes('"op":1')).length < 2 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const heartbeatSends = ws.send.mock.calls.filter((c) => String(c[0]).includes('"op":1'));
    expect(heartbeatSends.length).toBeGreaterThanOrEqual(2);
    expect(String(heartbeatSends[0]?.[0])).toContain('"d":5'); // 携带最新 lastSeq
    receiver.close();
  });

  it('正向：HEARTBEAT_ACK → 清除 ack 超时（不触发僵尸断开）', async () => {
    const { receiver, ws } = makeReceiver();
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello(10) });
    ws.emit('message', { data: frames.ready() });
    await p;
    // 每 10ms 心跳后 20ms ack 超时；及时回 ACK 则不断开
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 12));
      ws.emit('message', { data: frames.helloAck() });
    }
    expect(ws.close).not.toHaveBeenCalled();
    receiver.close();
  });

  it('异常：ack 超时（心跳后无 ACK）→ 僵尸连接判定 → 强制断开触发重连', async () => {
    const { receiver, fetchTokenFn, ws } = makeReceiver({ reconnectDelayMs: 5 });
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello(10) });
    ws.emit('message', { data: frames.ready() });
    await p;
    // 心跳 10ms + ack 超时 20ms → 40ms 内应强制断开
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(ws.close).toHaveBeenCalled();
    // 断开触发 close 事件 → 自动重连 → fetchToken 再次调用
    ws.emit('close');
    await vi.waitFor(() => expect(fetchTokenFn.mock.calls.length).toBeGreaterThanOrEqual(2));
    receiver.close();
  });
});

describe('QqStreamReceiver 事件分发（三件套）', () => {
  it('正向：GROUP_AT_MESSAGE → 群聊消息分发（@bot 前缀剥离）', async () => {
    const { receiver, ws } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello() });
    ws.emit('message', { data: frames.groupAt() });
    ws.emit('message', { data: frames.ready() });
    await p;
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'qq', chatId: 'g1', text: '你好', messageId: 'e1' }),
    );
    receiver.close();
  });

  it('正向：C2C_MESSAGE → 单聊消息分发（user_openid 为 chatId）', async () => {
    const { receiver, ws } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello() });
    ws.emit('message', { data: frames.c2c() });
    ws.emit('message', { data: frames.ready() });
    await p;
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'qq', chatId: 'u1', text: '单聊' }),
    );
    receiver.close();
  });

  it('边界：非文本 dispatch（未知 t）→ 不分发', async () => {
    const { receiver, ws } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: frames.hello() });
    ws.emit('message', { data: JSON.stringify({ op: 0, t: 'GUILD_UPDATE', d: {} }) });
    ws.emit('message', { data: frames.ready() });
    await p;
    expect(handler).not.toHaveBeenCalled();
    receiver.close();
  });

  it('边界：非法 JSON 帧 → 忽略不崩溃', async () => {
    const { receiver, ws } = makeReceiver();
    const p = receiver.open();
    await waitWs(ws);
    ws.emit('message', { data: 'not-json{' });
    ws.emit('message', { data: frames.hello() });
    ws.emit('message', { data: frames.ready() });
    await expect(p).resolves.toBeUndefined();
    receiver.close();
  });
});

describe('QqStreamReceiver.close（生命周期）', () => {
  it('正向：手动 close → 不触发重连', async () => {
    const { receiver, fetchTokenFn, ws } = makeReceiver();
    await completeHandshake(receiver, ws);
    receiver.close();
    expect(ws.close).toHaveBeenCalled();
    expect(receiver.isOpen).toBe(false);
    // 手动关闭后 close 事件不触发重连
    ws.emit('close');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchTokenFn.mock.calls.length).toBe(1);
  });

  it('边界：未 open 时 close → no-op 不抛', () => {
    const { receiver } = makeReceiver();
    expect(() => receiver.close()).not.toThrow();
  });
});

describe('fetchQqGatewayUrl（三件套）', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('正向：返回 url', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: 'wss://gw.qq.com/websocket' }),
    })) as unknown as typeof fetch;
    await expect(fetchQqGatewayUrl('tok')).resolves.toBe('wss://gw.qq.com/websocket');
  });

  it('异常：HTTP !ok → REQUEST_FAILED', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(fetchQqGatewayUrl('tok')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_REQUEST_FAILED,
    });
  });

  it('异常：响应缺 url → REQUEST_FAILED', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;
    await expect(fetchQqGatewayUrl('tok')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_REQUEST_FAILED,
    });
  });
});
