// src/main/__tests__/chat-service.test.ts
// chat-service 单测：streamText + toUIMessageStream + abort + 错误分类
//
// 测试要点：
// 1. startChat：生成 sessionId 并立即返回（异步推送 part）
// 2. startChat 续传：传入 sessionId 时复用
// 3. 正常完成：推送所有 part + CHAT_STREAM_END
// 4. abort：中断指定 sessionId，返回 true；不存在的返回 false
// 5. abortAll：中断所有活跃对话
// 6. 错误分类：按错误特征映射 ErrorCode 并推送 CHAT_STREAM_ERROR
// 7. AbortError：不推送 error，仅推送 END
// 8. webContents.isDestroyed：停止推送
// 9. getChatService / resetChatService 单例管理

import type { ChatMessage } from '@novel-writer/shared';
import { IPC_CHANNELS } from '@novel-writer/shared';
import type { WebContents } from 'electron';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const mocks = vi.hoisted(() => {
  // streamText mock：返回带 toUIMessageStream() 方法的对象
  // 默认返回空 stream（立即 done）
  const mockStreamText = vi.fn();
  // getModel mock：返回一个 sentinel 对象作为 model
  const mockModel = { __mockModel: true };
  const mockGetModel = vi.fn(async () => mockModel);
  // logger mock
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  // randomUUID mock：返回可预测的 id
  const mockRandomUUID = vi.fn(() => 'test-session-id');
  return {
    mockStreamText,
    mockGetModel,
    mockModel,
    mockLogger,
    mockRandomUUID,
  };
});

// mock ai：拦截 streamText（getModel 在 ai-provider.ts，但 chat-service 直接 import getModel）
vi.mock('ai', () => ({
  streamText: mocks.mockStreamText,
}));

// mock ai-provider：拦截 getModel，避免触发 keychain/config
vi.mock('../infra/ai/ai-provider', () => ({
  getModel: mocks.mockGetModel,
}));

// mock logger：避免触发真实 electron-log 初始化
vi.mock('../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

// mock node:crypto：拦截 randomUUID，返回可预测的 id
vi.mock('node:crypto', () => ({
  randomUUID: mocks.mockRandomUUID,
}));

import { getChatService, resetChatService } from '../infra/ai/chat-service';

/**
 * 创建 mock ReadableStream：按顺序推送 parts 后 close
 *
 * 用于 streamText 返回值的 toUIMessageStream() 方法。
 */
function createMockReadableStream(parts: unknown[]): ReadableStream {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

/**
 * 创建 mock streamText 返回值
 *
 * toUIMessageStream() 返回上述的 ReadableStream
 */
function createMockStreamResult(parts: unknown[]): { toUIMessageStream: () => ReadableStream } {
  return {
    toUIMessageStream: () => createMockReadableStream(parts),
  };
}

/**
 * Mock WebContents 类型
 *
 * 交叉类型：WebContents（满足 startChat 的类型签名）
 * + Mock 方法（便于测试中访问 .mock.calls / .mockReturnValue）
 *
 * mock 对象实际只实现了 send + isDestroyed，
 * 用 `as unknown as MockedWebContents` 断言以满足类型检查。
 */
type MockedWebContents = WebContents & {
  send: Mock;
  isDestroyed: Mock<() => boolean>;
};

/**
 * 创建 mock WebContents
 *
 * 仅暴露 chat-service 用到的方法：send + isDestroyed
 * send 调用会被 vi.fn 记录，便于断言
 */
function createMockWebContents(overrides?: { isDestroyed?: boolean }): MockedWebContents {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => overrides?.isDestroyed ?? false),
  } as unknown as MockedWebContents;
}

/**
 * 等待所有微任务/异步任务完成
 *
 * chat-service.startChat 不 await streamToWebContents，
 * 需主动 flush 异步队列后再断言 webContents.send 调用。
 *
 * 多次 await 让 streamToWebContents 内部所有 await 都完成。
 */
async function flushAsync(): Promise<void> {
  // streamToWebContents 内部有多个 await：getModel、reader.read()（可能多次）、finally
  // 多次微任务刷新确保所有 await 完成
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop -- 测试需要顺序刷新微任务队列
    await Promise.resolve();
  }
}

describe('chat-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置单例
    resetChatService();
    // 默认 streamText 返回空流（立即 close）
    mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));
    // 默认 randomUUID 返回 'test-session-id'
    mocks.mockRandomUUID.mockReturnValue('test-session-id');
  });

  describe('getChatService / resetChatService', () => {
    it('getChatService 返回单例', () => {
      const a = getChatService();
      const b = getChatService();
      expect(a).toBe(b);
    });

    it('resetChatService 后 getChatService 返回新实例', () => {
      const a = getChatService();
      resetChatService();
      const b = getChatService();
      expect(a).not.toBe(b);
    });
  });

  describe('startChat', () => {
    it('不传 sessionId：生成新 id 并立即返回', async () => {
      const wc = createMockWebContents();
      const sessionId = await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: undefined,
        webContents: wc,
      });

      expect(sessionId).toBe('test-session-id');
      expect(mocks.mockRandomUUID).toHaveBeenCalledTimes(1);
      // startChat 立即返回（不等流完成）
      expect(mocks.mockStreamText).toHaveBeenCalledTimes(1);
    });

    it('传入 sessionId：复用不生成新 id', async () => {
      const wc = createMockWebContents();
      const sessionId = await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'custom-session-id',
        webContents: wc,
      });

      expect(sessionId).toBe('custom-session-id');
      expect(mocks.mockRandomUUID).not.toHaveBeenCalled();
    });

    it('streamText 入参：传 model + messages + allowSystemInMessages + abortSignal', async () => {
      const wc = createMockWebContents();
      // 显式声明为 ChatMessage[]，否则 role 会被推断为 string 而非字面量联合类型
      const messages: ChatMessage[] = [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
      ];

      await getChatService().startChat({
        messages,
        sessionId: undefined,
        webContents: wc,
      });

      await flushAsync();

      expect(mocks.mockGetModel).toHaveBeenCalledWith(undefined);
      expect(mocks.mockStreamText).toHaveBeenCalledTimes(1);
      const callArgs = mocks.mockStreamText.mock.calls[0];
      if (!callArgs) {
        throw new Error('streamText 未被调用');
      }
      const opts = callArgs[0] as {
        model: unknown;
        messages: unknown;
        allowSystemInMessages: boolean;
        abortSignal: AbortSignal;
      };
      expect(opts.model).toBe(mocks.mockModel);
      expect(opts.messages).toEqual(messages);
      expect(opts.allowSystemInMessages).toBe(true);
      expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('正常完成：逐 part 推送 CHAT_STREAM_PART，最后推送 CHAT_STREAM_END', async () => {
      const wc = createMockWebContents();
      const parts = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ];
      mocks.mockStreamText.mockReturnValue(createMockStreamResult(parts));

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-1',
        webContents: wc,
      });

      await flushAsync();

      // 应该推送 2 个 part + 1 个 end
      expect(wc.send).toHaveBeenCalledTimes(3);

      // 第 1 个调用：CHAT_STREAM_PART
      const firstCall = wc.send.mock.calls[0];
      if (!firstCall) {
        throw new Error('webContents.send 未被调用');
      }
      expect(firstCall[0]).toBe(IPC_CHANNELS.CHAT_STREAM_PART);
      const partPayload = firstCall[1] as { sessionId: string; part: unknown };
      expect(partPayload.sessionId).toBe('session-1');
      expect(partPayload.part).toEqual({ type: 'text', text: 'hello' });

      // 最后一个调用：CHAT_STREAM_END
      const lastCall = wc.send.mock.calls[2];
      if (!lastCall) {
        throw new Error('最后一个 webContents.send 不存在');
      }
      expect(lastCall[0]).toBe(IPC_CHANNELS.CHAT_STREAM_END);
      expect(lastCall[1]).toEqual({ sessionId: 'session-1' });
    });

    it('webContents.isDestroyed=true：停止推送 part', async () => {
      // 让 isDestroyed 在推送期间返回 true
      const wc = createMockWebContents();
      wc.isDestroyed.mockReturnValue(true);

      const parts = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ];
      mocks.mockStreamText.mockReturnValue(createMockStreamResult(parts));

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-2',
        webContents: wc,
      });

      await flushAsync();

      // isDestroyed=true 后停止推送 part，也不推送 END
      // 注意：在 part 推送循环中先检查 isDestroyed 才推送，
      // 因此第一个 part 不会被推送（isDestroyed 已返回 true）
      expect(wc.send).not.toHaveBeenCalled();
    });

    it('AbortError：不推送 error，仅推送 CHAT_STREAM_END', async () => {
      const wc = createMockWebContents();
      // streamText 抛 AbortError
      mocks.mockStreamText.mockImplementation(() => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-abort',
        webContents: wc,
      });

      await flushAsync();

      // 应该只调用一次 send：CHAT_STREAM_END
      expect(wc.send).toHaveBeenCalledTimes(1);
      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      expect(call[0]).toBe(IPC_CHANNELS.CHAT_STREAM_END);
      expect(call[1]).toEqual({ sessionId: 'session-abort' });
      // 不应该推送 CHAT_STREAM_ERROR
      const errorCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CHAT_STREAM_ERROR);
      expect(errorCalls).toHaveLength(0);
    });

    it('API key 无效错误：推送 CHAT_STREAM_ERROR + AI_API_KEY_INVALID', async () => {
      const wc = createMockWebContents();
      const err = new Error('Invalid API key provided');
      mocks.mockStreamText.mockImplementation(() => {
        throw err;
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-err',
        webContents: wc,
      });

      await flushAsync();

      // 应该只调用一次 send：CHAT_STREAM_ERROR
      expect(wc.send).toHaveBeenCalledTimes(1);
      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      expect(call[0]).toBe(IPC_CHANNELS.CHAT_STREAM_ERROR);
      const payload = call[1] as { sessionId: string; code: string; message: string };
      expect(payload.sessionId).toBe('session-err');
      expect(payload.code).toBe('AI_API_KEY_INVALID');
    });

    it('限流错误：推送 AI_RATE_LIMITED', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockImplementation(() => {
        throw new Error('Rate limit exceeded (429)');
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-rl',
        webContents: wc,
      });

      await flushAsync();

      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('AI_RATE_LIMITED');
    });

    it('网络错误：推送 AI_STREAM_INTERRUPTED', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockImplementation(() => {
        throw new Error('fetch failed: network error');
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-net',
        webContents: wc,
      });

      await flushAsync();

      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('AI_STREAM_INTERRUPTED');
    });

    it('未知错误：推送 INTERNAL_ERROR', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockImplementation(() => {
        throw new Error('some unknown error');
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-unknown',
        webContents: wc,
      });

      await flushAsync();

      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('INTERNAL_ERROR');
    });

    it('正常完成后从 activeSessions 移除（abort 返回 false）', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(createMockStreamResult([{ type: 'text', text: 'ok' }]));

      const sessionId = await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: undefined,
        webContents: wc,
      });

      // 等待流完成
      await flushAsync();

      // 流结束后应从 Map 移除，abort 返回 false
      const result = getChatService().abort(sessionId);
      expect(result).toBe(false);
    });
  });

  describe('abort', () => {
    it('中断活跃 sessionId 返回 true', async () => {
      const wc = createMockWebContents();
      // 用一个永不 close 的流让 session 保持活跃
      mocks.mockStreamText.mockReturnValue({
        toUIMessageStream: () =>
          new ReadableStream({
            start() {
              // 不 enqueue 也不 close，让 reader.read() 永远 pending
            },
          }),
      });

      const sessionId = await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'active-session',
        webContents: wc,
      });

      // 中断
      const result = getChatService().abort(sessionId);
      expect(result).toBe(true);

      // 等待 AbortError 被捕获
      await flushAsync();
    });

    it('中断不存在的 sessionId 返回 false', () => {
      const result = getChatService().abort('nonexistent-id');
      expect(result).toBe(false);
    });
  });

  describe('abortAll', () => {
    it('中断所有活跃对话', async () => {
      const wc1 = createMockWebContents();
      const wc2 = createMockWebContents();

      // 关键：mock streamText 必须响应 abortSignal，否则 reader.read() 永远 pending
      // 真实 streamText 收到 abort 信号后会让 toUIMessageStream() 的 reader 抛 AbortError
      mocks.mockStreamText.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => ({
        toUIMessageStream: () =>
          new ReadableStream({
            start(controller) {
              if (abortSignal !== undefined) {
                abortSignal.addEventListener(
                  'abort',
                  () => {
                    const err = new Error('aborted');
                    err.name = 'AbortError';
                    controller.error(err);
                  },
                  { once: true },
                );
              }
            },
          }),
      }));

      mocks.mockRandomUUID.mockReturnValueOnce('session-a').mockReturnValueOnce('session-b');

      await getChatService().startChat({
        messages: [{ role: 'user', content: 'a' }],
        sessionId: undefined,
        webContents: wc1,
      });
      await getChatService().startChat({
        messages: [{ role: 'user', content: 'b' }],
        sessionId: undefined,
        webContents: wc2,
      });

      // 触发中断
      getChatService().abortAll();

      await flushAsync();

      // 两个 wc 都应该收到 CHAT_STREAM_END（AbortError 被捕获后推送 END）
      expect(wc1.send).toHaveBeenCalled();
      expect(wc2.send).toHaveBeenCalled();

      // 验证推送的是 CHAT_STREAM_END（而非 CHAT_STREAM_ERROR）
      const wc1Calls = wc1.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CHAT_STREAM_END);
      expect(wc1Calls).toHaveLength(1);
      const wc2Calls = wc2.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CHAT_STREAM_END);
      expect(wc2Calls).toHaveLength(1);
    });
  });
});
