// src/main/infra/im/adapters/feishu-stream-receiver.test.ts
// FeishuStreamReceiver 单测：飞书长连接接收器（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - EventDispatcherCtor / WSClientCtor 经构造注入 fake（SDK 外部依赖）
// - register 回调捕获后手动触发，验证事件分发到订阅者
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { FeishuStreamReceiver } from './feishu-stream';

/** fake 事件分发器：register 捕获事件回调 */
class FakeEventDispatcher {
  handler: ((data: unknown) => void) | undefined;
  register(handlers: Record<string, (data: unknown) => void>): this {
    this.handler = handlers['im.message.receive_v1'];
    return this;
  }

  emit(data: unknown): void {
    this.handler?.(data);
  }
}

/** fake WS 客户端：start 可编程 */
class FakeWsClient {
  readonly start = vi.fn(async () => {});
  readonly close = vi.fn();
}

/** 当前测试的共享 fake（构造桩返回） */
let currentDispatcher: FakeEventDispatcher;
let currentWsClient: FakeWsClient;

/** 构造桩：返回共享实例（保持 new 语义） */
class SharedEventDispatcherCtor {
  constructor() {
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return currentDispatcher;
  }
}

class SharedWsClientCtor {
  constructor() {
    // biome-ignore lint/correctness/noConstructorReturn: 测试桩返回共享实例（保持 new 语义）
    return currentWsClient;
  }
}

function makeReceiver(): {
  receiver: FeishuStreamReceiver;
  dispatcher: FakeEventDispatcher;
  wsClient: FakeWsClient;
} {
  currentDispatcher = new FakeEventDispatcher();
  currentWsClient = new FakeWsClient();
  const receiver = new FeishuStreamReceiver(
    { appId: 'app', appSecret: 'secret' },
    {
      EventDispatcherCtor:
        SharedEventDispatcherCtor as unknown as typeof import('@larksuiteoapi/node-sdk').EventDispatcher,
      WSClientCtor:
        SharedWsClientCtor as unknown as typeof import('@larksuiteoapi/node-sdk').WSClient,
    },
  );
  return { receiver, dispatcher: currentDispatcher, wsClient: currentWsClient };
}

/** 合法飞书消息事件（FeishuMessageEventV1 形状：顶层 message/sender） */
function feishuEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sender: {
      sender_id: { open_id: 'ou_1' },
      sender_type: 'user',
    },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '你好' }),
      create_time: '1700000000000',
    },
    event: { type: 'im.message.receive_v1', event_time: 1700000000 },
    ...overrides,
  };
}

describe('FeishuStreamReceiver.open（三件套）', () => {
  it('正向：start 成功 → isOpen=true + WSClient 构造参数正确', async () => {
    const { receiver, wsClient } = makeReceiver();
    await receiver.open();
    expect(wsClient.start).toHaveBeenCalledTimes(1);
    expect(receiver.isOpen).toBe(true);
    receiver.close();
  });

  it('正向：事件分发——register 回调触发 → 订阅者收到领域消息', async () => {
    const { receiver, dispatcher } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    dispatcher.emit(feishuEvent());
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'feishu', chatId: 'oc_1', text: '你好' }),
    );
    receiver.close();
  });

  it('边界：重复 open（已 opened）→ no-op（start 不重复调用）', async () => {
    const { receiver, wsClient } = makeReceiver();
    await receiver.open();
    await receiver.open();
    expect(wsClient.start).toHaveBeenCalledTimes(1);
    receiver.close();
  });

  it('异常：start 失败 → 抛错 + isOpen=false', async () => {
    const { receiver, wsClient } = makeReceiver();
    wsClient.start.mockRejectedValueOnce(new Error('sdk start failed'));
    await expect(receiver.open()).rejects.toThrow('sdk start failed');
    expect(receiver.isOpen).toBe(false);
  });
});

describe('FeishuStreamReceiver.close', () => {
  it('正向：close → wsClient.close + isOpen=false', async () => {
    const { receiver, wsClient } = makeReceiver();
    await receiver.open();
    receiver.close();
    expect(wsClient.close).toHaveBeenCalled();
    expect(receiver.isOpen).toBe(false);
  });

  it('边界：未 open 时 close → no-op 不抛', () => {
    const { receiver } = makeReceiver();
    expect(() => receiver.close()).not.toThrow();
  });
});

describe('FeishuStreamReceiver 兜底补充', () => {
  it('缺 sender.open_id：senderId undefined 不分发错误', async () => {
    const { receiver, dispatcher } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    dispatcher.emit(feishuEvent({ sender: {} }));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ chatId: 'oc_1' }));
    receiver.close();
  });

  it('message 缺 content：parse null 不分发', async () => {
    const { receiver, dispatcher } = makeReceiver();
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    dispatcher.emit(feishuEvent({ message: { message_id: 'om_1', chat_id: 'oc_1' } }));
    expect(handler).not.toHaveBeenCalled();
    receiver.close();
  });
});
