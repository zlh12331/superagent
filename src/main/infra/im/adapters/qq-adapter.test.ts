// src/main/infra/im/adapters/qq-adapter.test.ts
// QqAdapter 单测：QQ 渠道适配器（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - fetchTokenFn / Receiver / fetchFn 经构造注入 fake（网络/WS 外部依赖）
// - 消息路由（chatTypeMap 学习）、token 刷新窗口、错误分类全部真实实现
// ──────────────────────────────────────────────────────────────

import { ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '../channel/types';
import { QqAdapter } from './qq-adapter';
import type { QqStreamReceiver } from './qq-stream';

/** fake 接收器：捕获 onMessage handler 可手动触发 */
class FakeQqReceiver {
  handler: ((message: ChannelIncomingMessage) => void) | undefined;
  readonly open = vi.fn(async () => {});
  readonly close = vi.fn();

  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.handler = handler;
  }

  emit(message: ChannelIncomingMessage): void {
    this.handler?.(message);
  }
}

/** 默认成功响应体（err_code 用索引赋值绕开命名检查） */
const errOkBody: Record<string, number> = {};
errOkBody['err_code'] = 0;

/** 当前测试的共享 receiver（SharedQqReceiver 构造返回它，保持 adapter 的 new 语义） */
let currentReceiver: FakeQqReceiver;

/** 测试桩：new 返回共享 receiver 实例 */
class SharedQqReceiver {
  constructor() {
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return currentReceiver;
  }
}

/** fake fetch：可编程响应 */
function makeFetch(ok = true, body: unknown = errOkBody): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  }));
}

/** 构造注入全部依赖的适配器 */
function makeAdapter(): {
  adapter: QqAdapter;
  fetchToken: ReturnType<typeof vi.fn>;
  receiver: FakeQqReceiver;
  fetchFn: ReturnType<typeof vi.fn>;
} {
  const fetchToken = vi.fn(async () => ({ accessToken: 'test-token', expiresIn: 7200 }));
  const receiver = new FakeQqReceiver();
  currentReceiver = receiver;
  const fetchFn = makeFetch();
  const adapter = new QqAdapter({
    fetchToken: fetchToken as unknown as typeof import('./qq-stream').fetchQqAccessToken,
    // 测试桩构造返回共享实例：adapter 内 new ReceiverCtor 得到同一对象
    Receiver: SharedQqReceiver as unknown as typeof QqStreamReceiver,
    fetchFn: fetchFn as unknown as typeof fetch,
  });
  return { adapter, fetchToken, receiver, fetchFn };
}

function incoming(overrides: Partial<ChannelIncomingMessage> = {}): ChannelIncomingMessage {
  return {
    channel: 'qq',
    chatId: 'openid-1',
    senderId: 'u1',
    text: 'hello',
    messageId: 'm1',
    timestamp: 123,
    ...overrides,
  };
}

describe('QqAdapter.connect（三件套）', () => {
  it('异常：token undefined → INVALID_TOKEN', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.connect(undefined)).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });

  it('异常：token 空串 → INVALID_TOKEN', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.connect('')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });

  it('异常：token 格式错（缺 appSecret）→ INVALID_TOKEN', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.connect('only-app-id')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });

  it('异常：token 格式错（appId 为空）→ INVALID_TOKEN', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.connect(':secret')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
  });

  it('正向：合法 token → fetchToken 调用 + receiver.open + isConnected=true', async () => {
    const { adapter, fetchToken, receiver } = makeAdapter();
    await adapter.connect('app123:secret456');
    expect(fetchToken).toHaveBeenCalledWith('app123', 'secret456');
    expect(receiver.open).toHaveBeenCalled();
    expect(adapter.isConnected).toBe(true);
  });

  it('正向：fetchToken 失败（网络）→ 异常向上抛，不置 connected', async () => {
    const { adapter, fetchToken } = makeAdapter();
    fetchToken.mockRejectedValueOnce(new Error('network down'));
    await expect(adapter.connect('app123:secret456')).rejects.toThrow('network down');
    expect(adapter.isConnected).toBe(false);
  });
});

describe('QqAdapter 消息分发（chatTypeMap 学习）', () => {
  it('正向：入站消息 → 订阅者收到 + channelType 学习路由', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('app123:secret456');
    const handler = vi.fn();
    adapter.onMessage(handler);
    receiver.emit(incoming({ chatId: 'g-openid', channelType: 'group' }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'g-openid', text: 'hello' }),
    );
    // 学习后：回发走群聊端点
    await adapter.sendMessage({ chatId: 'g-openid' }, 'reply');
    const url = adapter as unknown as { fetchFn: ReturnType<typeof vi.fn> };
    expect(String(url.fetchFn.mock.calls[0]?.[0])).toContain('/v2/groups/g-openid/messages');
  });

  it('正向：无 channelType 消息 → 不学习（回发默认单聊）', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('app123:secret456');
    // exactOptionalPropertyTypes：channelType 省略等价 undefined（不显式传 undefined）
    receiver.emit(incoming({}));
    await adapter.sendMessage({ chatId: 'unknown-id' }, 'reply');
    const url = adapter as unknown as { fetchFn: ReturnType<typeof vi.fn> };
    expect(String(url.fetchFn.mock.calls[0]?.[0])).toContain('/v2/users/unknown-id/messages');
  });

  it('异常：监听器抛错 → 隔离不中断其他监听器', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('app123:secret456');
    const bad = vi.fn(() => {
      throw new Error('listener crash');
    });
    const good = vi.fn();
    adapter.onMessage(bad);
    adapter.onMessage(good);
    expect(() => receiver.emit(incoming())).not.toThrow();
    expect(good).toHaveBeenCalled();
  });

  it('边界：onMessage 退订后不再收到', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('app123:secret456');
    const handler = vi.fn();
    const unsubscribe = adapter.onMessage(handler);
    unsubscribe();
    receiver.emit(incoming());
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('QqAdapter.sendMessage（三件套）', () => {
  it('异常：accessToken 为 null（未连接成功）→ NOT_CONFIGURED', async () => {
    const { adapter } = makeAdapter();
    // 不调用 connect：accessToken 保持 null
    await expect(adapter.sendMessage({ chatId: 'x' }, 'hi')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_NOT_CONFIGURED,
    });
  });

  it('正向：发送成功（err_code=0）→ 不抛', async () => {
    const { adapter, fetchFn } = makeAdapter();
    await adapter.connect('app123:secret456');
    await expect(adapter.sendMessage({ chatId: 'u1' }, 'hi')).resolves.toBeUndefined();
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://api.sgroup.qq.com/v2/users/u1/messages');
    expect(init).toMatchObject({ method: 'POST' });
  });

  it('异常：HTTP !ok → 抛错', async () => {
    const { adapter, fetchFn } = makeAdapter();
    fetchFn.mockImplementationOnce(async () => ({
      ok: false,
      status: 502,
      json: async () => null,
    }));
    await adapter.connect('app123:secret456');
    await expect(adapter.sendMessage({ chatId: 'u1' }, 'hi')).rejects.toThrow('HTTP 502');
  });

  it('异常：err_code ≠ 0 → 抛错（含 err_code 与 message）', async () => {
    const { adapter, fetchFn } = makeAdapter();
    const errBody: Record<string, unknown> = {};
    errBody['err_code'] = 40003;
    errBody['message'] = 'invalid openid';
    fetchFn.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => errBody,
    }));
    await adapter.connect('app123:secret456');
    await expect(adapter.sendMessage({ chatId: 'u1' }, 'hi')).rejects.toThrow('40003');
  });

  it('边界：token 临近过期（剩余 <60s）→ 发送前自动刷新', async () => {
    const { adapter, fetchToken } = makeAdapter();
    // expiresIn=1 → 过期时间 = now + 1s，立即进入刷新窗口
    fetchToken.mockImplementationOnce(async () => ({ accessToken: 't1', expiresIn: 1 }));
    await adapter.connect('app123:secret456');
    await adapter.sendMessage({ chatId: 'u1' }, 'hi');
    expect(fetchToken).toHaveBeenCalledTimes(2); // connect 1 次 + 刷新 1 次
  });
});

describe('QqAdapter.disconnect', () => {
  it('正向：连接后断开 → receiver.close + isConnected=false', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('app123:secret456');
    await adapter.disconnect();
    expect(receiver.close).toHaveBeenCalled();
    expect(adapter.isConnected).toBe(false);
  });

  it('边界：未连接时 disconnect → no-op 不抛', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});
