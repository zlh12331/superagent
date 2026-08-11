// src/main/infra/im/adapters/weixin-adapter.test.ts
// WeixinAdapter 单测：微信 iLink 渠道适配器（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - sendTextFn / Receiver 经构造注入 fake（网络外部依赖）
// - token 校验、消息分发、context_token 携带全部真实实现
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { ChannelIncomingMessage } from '../channel/types';
import { WeixinAdapter } from './weixin-adapter';
import type { WeixinStreamReceiver } from './weixin-stream';

/** fake 接收器：捕获 onMessage handler 可手动触发 */
class FakeWeixinReceiver {
  handler: ((message: ChannelIncomingMessage) => void) | undefined;
  readonly open = vi.fn(async () => {});
  readonly close = vi.fn();
  readonly getContextToken = vi.fn((chatId: string) => `ctx-${chatId}`);

  onMessage(handler: (message: ChannelIncomingMessage) => void): void {
    this.handler = handler;
  }

  emit(message: ChannelIncomingMessage): void {
    this.handler?.(message);
  }
}

/** 当前测试的共享 receiver（SharedWeixinReceiver 构造返回它，保持 adapter 的 new 语义） */
let currentReceiver: FakeWeixinReceiver;

/** 测试桩：new 返回共享 receiver 实例 */
class SharedWeixinReceiver {
  constructor() {
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return currentReceiver;
  }
}

function makeAdapter(): {
  adapter: WeixinAdapter;
  sendText: ReturnType<typeof vi.fn>;
  receiver: FakeWeixinReceiver;
} {
  const sendText = vi.fn(async () => {});
  const receiver = new FakeWeixinReceiver();
  currentReceiver = receiver;
  const adapter = new WeixinAdapter({
    sendText: sendText as unknown as typeof import('./weixin-stream').sendWeixinText,
    // 测试桩构造返回共享实例：adapter 内 new ReceiverCtor 得到同一对象
    Receiver: SharedWeixinReceiver as unknown as typeof WeixinStreamReceiver,
  });
  return { adapter, sendText, receiver };
}

function incoming(overrides: Partial<ChannelIncomingMessage> = {}): ChannelIncomingMessage {
  return {
    channel: 'wechat',
    chatId: 'user-1',
    senderId: 'user-1',
    text: 'hello',
    messageId: 'm1',
    timestamp: 123,
    ...overrides,
  };
}

describe('WeixinAdapter.connect（三件套）', () => {
  it('异常：token undefined → 抛错', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.connect(undefined)).rejects.toThrow('缺少 iLink token');
  });

  it('边界：token 纯空白 → 抛错', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.connect('   ')).rejects.toThrow('缺少 iLink token');
  });

  it('正向：合法 token → Receiver 构造 + open + isConnected=true（token 去空白）', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('  tok-123  ');
    expect(receiver.open).toHaveBeenCalled();
    expect(adapter.isConnected).toBe(true);
  });

  it('正向：消息分发 → 订阅者收到', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('tok-123');
    const handler = vi.fn();
    adapter.onMessage(handler);
    receiver.emit(incoming());
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }));
  });

  it('异常：监听器抛错 → 隔离不中断', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('tok-123');
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
    await adapter.connect('tok-123');
    const handler = vi.fn();
    const unsubscribe = adapter.onMessage(handler);
    unsubscribe();
    receiver.emit(incoming());
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('WeixinAdapter.sendMessage（三件套）', () => {
  it('异常：未连接 → 抛错', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.sendMessage({ chatId: 'user-1' }, 'hi')).rejects.toThrow('渠道未连接');
  });

  it('正向：发送 → sendText 调用（含 context_token）', async () => {
    const { adapter, sendText } = makeAdapter();
    await adapter.connect('tok-123');
    await expect(adapter.sendMessage({ chatId: 'user-1' }, 'reply')).resolves.toBeUndefined();
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        token: 'tok-123',
        toUserId: 'user-1',
        text: 'reply',
        contextToken: 'ctx-user-1',
      }),
    );
  });

  it('边界：发送失败（网络）→ 异常向上抛', async () => {
    const { adapter, sendText } = makeAdapter();
    sendText.mockRejectedValueOnce(new Error('network down'));
    await adapter.connect('tok-123');
    await expect(adapter.sendMessage({ chatId: 'user-1' }, 'hi')).rejects.toThrow('network down');
  });
});

describe('WeixinAdapter.disconnect', () => {
  it('正向：断开 → receiver.close + isConnected=false', async () => {
    const { adapter, receiver } = makeAdapter();
    await adapter.connect('tok-123');
    await adapter.disconnect();
    expect(receiver.close).toHaveBeenCalled();
    expect(adapter.isConnected).toBe(false);
  });

  it('边界：未连接时 disconnect → no-op 不抛', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.disconnect()).resolves.toBeUndefined();
  });
});
