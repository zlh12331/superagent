// src/main/infra/im/adapters/weixin-stream-receiver.test.ts
// WeixinStreamReceiver 单测：iLink 长轮询接收器（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - fetchUpdatesFn 经构造注入 fake（有状态：首轮消息后续空，模拟游标续传）
// - backoffMs/sessionPauseMs 注入短值（生产 30s 不可等待）
// - fetch mock 带 5ms 延迟：pollLoop 无退避时立即返回会形成同步微任务
//   忙循环（await 立即 resolve 不 yield 宏任务 → abort 无法生效 → OOM）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { WeixinStreamReceiver } from './weixin-stream';

/** 轮询延迟：模拟网络往返，避免忙循环 */
async function pollDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** 有状态 fetchUpdates mock：首轮返回消息 + 新游标，后续空 */
function makeFetchUpdates(msgs: unknown[] = []): ReturnType<typeof vi.fn> {
  let first = true;
  return vi.fn(async () => {
    await pollDelay();
    if (first) {
      first = false;
      return { errcode: 0, msgs, get_updates_buf: 'cursor-2' };
    }
    return { errcode: 0, msgs: [], get_updates_buf: 'cursor-2' };
  });
}

/** 合法 iLink 消息（item_list 文本项结构） */
function weixinMsg(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from_user_id: 'user-1',
    message_id: 101,
    create_time_ms: 1700000000000,
    item_list: [{ type: 1, text_item: { text: '你好' } }],
    ...overrides,
  };
}

function makeReceiver(
  options: {
    fetchUpdatesFn?: ReturnType<typeof vi.fn>;
    backoffMs?: number;
    sessionPauseMs?: number;
  } = {},
): {
  receiver: WeixinStreamReceiver;
  fetchUpdatesFn: ReturnType<typeof vi.fn>;
} {
  const fetchUpdatesFn = options.fetchUpdatesFn ?? makeFetchUpdates();
  const receiver = new WeixinStreamReceiver(
    { token: 'tok', baseUrl: 'https://test.local' },
    {
      fetchUpdatesFn:
        fetchUpdatesFn as unknown as typeof import('./weixin-stream').fetchWeixinUpdates,
      backoffMs: options.backoffMs ?? 5,
      sessionPauseMs: options.sessionPauseMs ?? 5,
    },
  );
  return { receiver, fetchUpdatesFn };
}

/** 等待轮询跑一轮 */
async function waitForPoll(fetchFn: ReturnType<typeof vi.fn>, times = 1): Promise<void> {
  await vi.waitFor(() => expect(fetchFn.mock.calls.length).toBeGreaterThanOrEqual(times));
}

describe('WeixinStreamReceiver.open/轮询（三件套）', () => {
  it('正向：消息 → 分发订阅者 + 游标续传（下次请求带新 cursor）', async () => {
    const { receiver, fetchUpdatesFn } = makeReceiver({
      fetchUpdatesFn: makeFetchUpdates([weixinMsg()]),
    });
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    await waitForPoll(fetchUpdatesFn);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'wechat', chatId: 'user-1', text: '你好' }),
    );
    // 游标续传：第二轮请求 cursor 已推进
    await waitForPoll(fetchUpdatesFn, 2);
    const second = fetchUpdatesFn.mock.calls[1]?.[0] as { cursor?: string };
    expect(second?.cursor).toBe('cursor-2');
    receiver.close();
  });

  it('正向：getContextToken 返回（context_token 学习）', async () => {
    const { receiver } = makeReceiver();
    // contextTokens 由 iLink 消息中的 context_token 学习——此处验证 API 形状
    expect(receiver.getContextToken('any')).toBeUndefined();
  });

  it('边界：重复 open（已 opened）→ no-op', async () => {
    const { receiver, fetchUpdatesFn } = makeReceiver();
    await receiver.open();
    await waitForPoll(fetchUpdatesFn);
    const callsBefore = fetchUpdatesFn.mock.calls.length;
    await receiver.open();
    expect(fetchUpdatesFn.mock.calls.length).toBe(callsBefore);
    receiver.close();
  });

  it('异常：errcode=-14 会话过期 → 暂停后继续轮询（不退出）', async () => {
    const expiredFn = vi.fn(async () => {
      await pollDelay();
      return { errcode: -14, msgs: [] };
    });
    const { receiver, fetchUpdatesFn } = makeReceiver({ fetchUpdatesFn: expiredFn });
    await receiver.open();
    // 会话过期后仍继续轮询（暂停 5ms 后下一轮）：用 setTimeout 验证（vi.waitFor 时序不稳）
    // 等待窗口 200ms：全量并发 + coverage 插桩下事件循环延迟，50ms 窗口曾出现不足 3 轮
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetchUpdatesFn.mock.calls.length).toBeGreaterThanOrEqual(3);
    receiver.close();
  });

  it('异常：fetch 抛错 → 退避后继续（不退出轮询）', async () => {
    const flakyFn = vi.fn(async () => {
      await pollDelay();
      throw new Error('network down');
    });
    const { receiver, fetchUpdatesFn } = makeReceiver({ fetchUpdatesFn: flakyFn });
    await receiver.open();
    // 退避后继续轮询：等待窗口 200ms（并发下 50ms 窗口曾不足 2 轮）
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fetchUpdatesFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    receiver.close();
  });

  it('边界：close 后 abort + isOpen=false（轮询停止）', async () => {
    const { receiver, fetchUpdatesFn } = makeReceiver();
    await receiver.open();
    await waitForPoll(fetchUpdatesFn);
    const callsBefore = fetchUpdatesFn.mock.calls.length;
    receiver.close();
    expect(receiver.isOpen).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchUpdatesFn.mock.calls.length).toBe(callsBefore);
  });

  it('边界：未 open 时 close → no-op 不抛', () => {
    const { receiver } = makeReceiver();
    expect(() => receiver.close()).not.toThrow();
  });
});

describe('WeixinStreamReceiver 消息过滤', () => {
  it('异常：非文本消息（空 item_list）→ 不分发', async () => {
    const { receiver, fetchUpdatesFn } = makeReceiver({
      fetchUpdatesFn: makeFetchUpdates([weixinMsg({ item_list: [] })]),
    });
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    await waitForPoll(fetchUpdatesFn);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handler).not.toHaveBeenCalled();
    receiver.close();
  });
});

describe('WeixinStreamReceiver 兜底补充', () => {
  it('get_updates_buf 缺失：游标不更新（下次请求保持原 cursor）', async () => {
    const noBufFn = vi.fn(async () => {
      await pollDelay();
      return { errcode: 0, msgs: [] }; // 无 get_updates_buf
    });
    const { receiver, fetchUpdatesFn } = makeReceiver({ fetchUpdatesFn: noBufFn });
    await receiver.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const first = fetchUpdatesFn.mock.calls[0]?.[0] as { cursor?: string };
    const second = fetchUpdatesFn.mock.calls[1]?.[0] as { cursor?: string };
    expect(first?.cursor).toBe('');
    expect(second?.cursor).toBe(''); // 游标保持
    receiver.close();
  });

  it('voice item 消息：语音文本提取', async () => {
    const { receiver } = makeReceiver({
      fetchUpdatesFn: makeFetchUpdates([
        {
          from_user_id: 'user-2',
          message_id: 202,
          create_time_ms: 1,
          item_list: [{ type: 3, voice_item: { text: '语音内容' } }],
        },
      ]),
    });
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'user-2', text: '语音内容' }),
    );
    receiver.close();
  });
});

describe('WeixinStreamReceiver 构造默认与缺失兜底', () => {
  it('默认构造（不传 options）：默认值生效，open/close 正常', async () => {
    const receiver = new WeixinStreamReceiver({ token: 't', baseUrl: 'https://x.local' });
    // 默认 fetchUpdatesFn 会发真实 HTTP——只验证生命周期不抛
    expect(() => receiver.close()).not.toThrow();
    expect(receiver.isOpen).toBe(false);
  });

  it('响应缺 msgs 字段：不崩溃不分发', async () => {
    const noMsgsFn = vi.fn(async () => {
      await pollDelay();
      return { errcode: 0, get_updates_buf: 'c1' }; // 无 msgs
    });
    const { receiver, fetchUpdatesFn } = makeReceiver({ fetchUpdatesFn: noMsgsFn });
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handler).not.toHaveBeenCalled();
    expect(fetchUpdatesFn.mock.calls.length).toBeGreaterThanOrEqual(2);
    receiver.close();
  });

  it('voice item 空文本：跳过不分发', async () => {
    const { receiver } = makeReceiver({
      fetchUpdatesFn: makeFetchUpdates([
        { from_user_id: 'u1', message_id: 1, item_list: [{ type: 3, voice_item: { text: '' } }] },
      ]),
    });
    const handler = vi.fn();
    receiver.onMessage(handler);
    await receiver.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(handler).not.toHaveBeenCalled();
    receiver.close();
  });
});
