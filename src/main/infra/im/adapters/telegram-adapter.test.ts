// src/main/infra/im/adapters/telegram-adapter.test.ts
// TelegramAdapter 单测：Bot API 长轮询渠道（正向/边界/异常三件套）
// ──────────────────────────────────────────────────────────────
// 测试策略（遵循"业务逻辑不 mock、外部依赖注入 fake"）：
// - fetchFn 经构造注入 fake（按 method 分发 getMe/getUpdates/sendMessage）
// - 轮询分发（文本过滤/@bot 剥离/监听器隔离）用真实 dispatchUpdate 逻辑驱动
// - getUpdates mock 统一带 5ms 延迟：pollLoop 无退避（生产为 30s 长轮询），
//   立即返回会形成忙循环导致 mock.calls 无限增长 OOM（实测 4GB 崩溃）
// ──────────────────────────────────────────────────────────────

import { ErrorCode } from '@code-agent/shared/main';
import { describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from './telegram-adapter';

interface FetchResult {
  ok: boolean;
  status: number;
  json: unknown;
}

/** getUpdates 统一延迟：模拟长轮询节奏，避免忙循环 */
async function pollDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** 按 API method 分发的 fake fetch */
function makeFetch(
  handlers: Record<string, () => FetchResult | Promise<FetchResult>>,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    const method = String(url).split('/').pop();
    const handler = handlers[method ?? ''];
    if (handler === undefined) {
      return { ok: false, status: 404, json: {} };
    }
    const res = await handler();
    return { ok: res.ok, status: res.status, json: async () => res.json };
  });
}

function makeAdapter(handlers: Record<string, () => FetchResult | Promise<FetchResult>>): {
  adapter: TelegramAdapter;
  fetchFn: ReturnType<typeof vi.fn>;
} {
  const fetchFn = makeFetch(handlers);
  const adapter = new TelegramAdapter({ fetchFn: fetchFn as unknown as typeof fetch });
  return { adapter, fetchFn };
}

/** 等待轮询循环跑一轮（getUpdates 被调用） */
async function waitForPoll(fetchFn: ReturnType<typeof vi.fn>, times = 1): Promise<void> {
  await vi.waitFor(() => {
    const calls = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/getUpdates'));
    expect(calls.length).toBeGreaterThanOrEqual(times);
  });
}

const okGetMe = (): FetchResult => ({
  ok: true,
  status: 200,
  json: { ok: true, result: { username: 'MyBot' } },
});

/** 空 updates（无消息） */
const emptyUpdates = (): FetchResult => ({
  ok: true,
  status: 200,
  json: { ok: true, result: [] },
});

describe('TelegramAdapter.connect（三件套）', () => {
  it('异常：token undefined/空 → NOT_CONFIGURED', async () => {
    const { adapter } = makeAdapter({ getMe: okGetMe });
    await expect(adapter.connect(undefined)).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_NOT_CONFIGURED,
    });
    await expect(adapter.connect('')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_NOT_CONFIGURED,
    });
  });

  it('正向：getMe 通过 → connected + 启动轮询', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return emptyUpdates();
      },
    });
    await adapter.connect('token-123');
    expect(adapter.isConnected).toBe(true);
    await waitForPoll(fetchFn);
    await adapter.disconnect();
  });

  it('异常：getMe !ok → INVALID_TOKEN', async () => {
    const { adapter } = makeAdapter({
      getMe: () => ({ ok: false, status: 401, json: { ok: false, description: 'Unauthorized' } }),
    });
    await expect(adapter.connect('bad-token')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
    expect(adapter.isConnected).toBe(false);
  });

  it('边界：重复 connect → 幂等返回（不重复验证）', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return emptyUpdates();
      },
    });
    await adapter.connect('token-123');
    await adapter.connect('token-123');
    await adapter.disconnect();
    // getMe 只调用 1 次（幂等短路）
    const getMeCalls = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/getMe'));
    expect(getMeCalls).toHaveLength(1);
  });
});

describe('TelegramAdapter 长轮询分发（dispatchUpdate）', () => {
  const oneTextMessage = (text: string, chatType = 'private'): FetchResult => ({
    ok: true,
    status: 200,
    json: {
      ok: true,
      result: [
        {
          update_id: 1,
          message: {
            message_id: 101,
            text,
            chat: { id: 777, type: chatType },
            from: { id: 42, username: 'alice' },
            date: 1700000000,
          },
        },
      ],
    },
  });

  it('正向：文本消息 → 订阅者收到领域形状', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      // 有状态 mock：首轮返回消息（模拟 Telegram offset 确认后不再重复），后续空
      getUpdates: (() => {
        let delivered = false;
        return async () => {
          await pollDelay();
          if (delivered) {
            return emptyUpdates();
          }
          delivered = true;
          return oneTextMessage('你好');
        };
      })(),
    });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect('token-123');
    await waitForPoll(fetchFn);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith({
      channel: 'telegram',
      chatId: '777',
      senderId: '42',
      text: '你好',
      messageId: '101',
      timestamp: 1700000000000,
    });
    await adapter.disconnect();
  });

  it('边界：非文本消息（无 text）→ 忽略不分发', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return {
          ok: true,
          status: 200,
          json: {
            ok: true,
            result: [
              {
                update_id: 1,
                message: { message_id: 1, chat: { id: 1, type: 'private' }, date: 1 },
              },
            ],
          },
        };
      },
    });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect('token-123');
    await waitForPoll(fetchFn);
    // 给轮询循环一点时间（无消息应无分发）
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handler).not.toHaveBeenCalled();
    await adapter.disconnect();
  });

  it('边界：群聊 @bot 前缀剥离（防自回复循环）', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      // 有状态 mock：首轮返回群聊消息，后续空（模拟 offset 确认）
      getUpdates: (() => {
        let delivered = false;
        return async () => {
          await pollDelay();
          if (delivered) {
            return emptyUpdates();
          }
          delivered = true;
          return oneTextMessage('@MyBot 用户内容', 'group');
        };
      })(),
    });
    const handler = vi.fn();
    adapter.onMessage(handler);
    await adapter.connect('token-123');
    await waitForPoll(fetchFn);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ text: '用户内容' }));
    await adapter.disconnect();
  });

  it('异常：监听器抛错 → 隔离不中断轮询', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      // 有状态 mock：首轮消息后转空（避免重复触发坏监听器）
      getUpdates: (() => {
        let delivered = false;
        return async () => {
          await pollDelay();
          if (delivered) {
            return emptyUpdates();
          }
          delivered = true;
          return oneTextMessage('x');
        };
      })(),
    });
    const bad = vi.fn(() => {
      throw new Error('listener crash');
    });
    adapter.onMessage(bad);
    await adapter.connect('token-123');
    await waitForPoll(fetchFn);
    // 轮询不因监听器异常退出
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adapter.isConnected).toBe(true);
    await adapter.disconnect();
  });
});

describe('TelegramAdapter.sendMessage（三件套）', () => {
  it('异常：未连接 → NOT_CONFIGURED', async () => {
    const { adapter } = makeAdapter({ getMe: okGetMe });
    await expect(adapter.sendMessage({ chatId: '1' }, 'hi')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_NOT_CONFIGURED,
    });
  });

  it('正向：sendMessage 成功 → 不抛', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return emptyUpdates();
      },
      sendMessage: () => ({ ok: true, status: 200, json: { ok: true } }),
    });
    await adapter.connect('token-123');
    await expect(adapter.sendMessage({ chatId: '42' }, 'reply')).resolves.toBeUndefined();
    const sendCalls = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/sendMessage'));
    expect(sendCalls).toHaveLength(1);
    await adapter.disconnect();
  });

  it('异常：API 失败 → 重试 3 次后耗尽（不抛，记日志）', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return emptyUpdates();
      },
      sendMessage: () => ({
        ok: false,
        status: 400,
        json: { ok: false, description: 'bad request' },
      }),
    });
    await adapter.connect('token-123');
    await expect(adapter.sendMessage({ chatId: '42' }, 'reply')).resolves.toBeUndefined();
    const sendCalls = fetchFn.mock.calls.filter((c) => String(c[0]).endsWith('/sendMessage'));
    expect(sendCalls).toHaveLength(3); // 初始 + 2 次重试
    await adapter.disconnect();
  });

  it('异常：HTTP 401（token 无效）→ INVALID_TOKEN（callApi 错误分类）', async () => {
    const { adapter } = makeAdapter({
      getMe: () => ({ ok: false, status: 401, json: { ok: false, description: 'Unauthorized' } }),
    });
    await expect(adapter.connect('bad-token')).rejects.toMatchObject({
      code: ErrorCode.IM_CHANNEL_INVALID_TOKEN,
    });
    expect(adapter.isConnected).toBe(false);
  });

  it('异常：HTTP 429 → 重试 3 次后耗尽（不抛，记日志）', async () => {
    const fetchFn2 = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sendMessage')) {
        return { ok: false, status: 429, json: async () => ({}) };
      }
      // 必须带延迟：getUpdates 立即返回会使 pollLoop 进入同步微任务链无限循环
      // （await 立即 resolve 不 yield 宏任务 → disconnect 的 abort 无法生效 → OOM）
      await pollDelay();
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [] }) };
    });
    const adapter2 = new TelegramAdapter({ fetchFn: fetchFn2 as unknown as typeof fetch });
    await adapter2.connect('token-123');
    // 429 触发 AppError 捕获 → 重试耗尽后静默（fire-and-forget 设计）
    await expect(adapter2.sendMessage({ chatId: '42' }, 'reply')).resolves.toBeUndefined();
    const sendCalls = fetchFn2.mock.calls.filter((c) => String(c[0]).endsWith('/sendMessage'));
    expect(sendCalls).toHaveLength(3);
    await adapter2.disconnect();
  });
});

describe('TelegramAdapter.onMessage/disconnect', () => {
  it('边界：onMessage 退订后不再收到', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return {
          ok: true,
          status: 200,
          json: {
            ok: true,
            result: [
              {
                update_id: 1,
                message: { message_id: 1, text: 'x', chat: { id: 1, type: 'private' }, date: 1 },
              },
            ],
          },
        };
      },
    });
    const handler = vi.fn();
    const unsubscribe = adapter.onMessage(handler);
    unsubscribe();
    await adapter.connect('token-123');
    await waitForPoll(fetchFn);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(handler).not.toHaveBeenCalled();
    await adapter.disconnect();
  });

  it('正向：disconnect → 停止轮询 + 清空监听', async () => {
    const { adapter, fetchFn } = makeAdapter({
      getMe: okGetMe,
      getUpdates: async () => {
        await pollDelay();
        return emptyUpdates();
      },
    });
    await adapter.connect('token-123');
    await waitForPoll(fetchFn);
    const callsBefore = fetchFn.mock.calls.length;
    await adapter.disconnect();
    expect(adapter.isConnected).toBe(false);
    // 断开后轮询不再继续
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchFn.mock.calls.length).toBe(callsBefore);
  });
});
