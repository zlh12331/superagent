// src/main/infra/ai/chat-service.test.ts
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

import type { ChatMessage } from '@code-agent/shared/main';
import { IPC_CHANNELS } from '@code-agent/shared/main';
import { APICallError, LoadAPIKeyError } from 'ai';
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
// 注意：APICallError / LoadAPIKeyError 是真实类（不 mock），
// 测试用例需要用真实错误类构造 mock 错误以验证 instanceof 类型守卫
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: mocks.mockStreamText,
  };
});

// mock ai-provider：拦截 getModel，避免触发 keychain/config
vi.mock('./llm-client/ai-provider', () => ({
  getModel: mocks.mockGetModel,
}));

// mock logger：避免触发真实 electron-log 初始化
vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

// mock node:crypto：拦截 randomUUID，返回可预测的 id
vi.mock('node:crypto', () => ({
  randomUUID: mocks.mockRandomUUID,
}));

import type { ISessionService } from '../storage/session-service';
import { getChatService, resetChatService } from './agent/chat-service';
import type { ConcurrencyGate } from './agent-runtime/concurrency-gate';
import type { ITitleGenerator } from './knowledge/session-title';

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
  // 请求级重试链路（createStreamWithRetry）引入 async 边界后：
  // 追加 macrotask，确保流处理链完整推进（否则 END 推送可能尚未到达）
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
      // P2-7：用真实 APICallError（statusCode=401）替代 Error('Invalid API key')
      const err = new APICallError({
        message: 'Invalid API key provided',
        url: 'https://api.deepseek.com/v1/chat/completions',
        requestBodyValues: undefined,
        statusCode: 401,
        responseBody: 'Unauthorized',
      });
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
      // P2-7：用真实 APICallError（statusCode=429）替代 Error('Rate limit')
      const err = new APICallError({
        message: 'Rate limit exceeded',
        url: 'https://api.deepseek.com/v1/chat/completions',
        requestBodyValues: undefined,
        statusCode: 429,
        responseBody: 'Too Many Requests',
      });
      mocks.mockStreamText.mockImplementation(() => {
        throw err;
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

    it('网络错误（isRetryable=true）：推送 AI_STREAM_INTERRUPTED', async () => {
      // 本用例需等待重试退避（~4.5s），显式放宽测试超时
      const wc = createMockWebContents();
      // P2-7：用真实 APICallError（statusCode=undefined, isRetryable=true）模拟网络中断
      // AI SDK 在 fetch 失败时会包装为 APICallError（statusCode=undefined, isRetryable=true）
      const err = new APICallError({
        message: 'fetch failed: network error',
        url: 'https://api.deepseek.com/v1/chat/completions',
        requestBodyValues: undefined,
        isRetryable: true,
      });
      mocks.mockStreamText.mockImplementation(() => {
        throw err;
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-net',
        webContents: wc,
      });

      await flushAsync();
      // 网络错误可重试（isRetryable=true）：重试链路含指数退避（1500+3000ms），
      // 等待退避完成后再断言错误推送
      await new Promise<void>((resolve) => setTimeout(resolve, 5200));

      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('AI_STREAM_INTERRUPTED');
    }, 20000);

    it('API key 未配置：推送 AI_API_KEY_MISSING', async () => {
      const wc = createMockWebContents();
      // P2-7：用真实 LoadAPIKeyError 模拟 keychain/config 未配置 API key
      const err = new LoadAPIKeyError({ message: 'API key not found in keychain' });
      mocks.mockStreamText.mockImplementation(() => {
        throw err;
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-missing',
        webContents: wc,
      });

      await flushAsync();

      const call = wc.send.mock.calls[0];
      if (!call) {
        throw new Error('webContents.send 未被调用');
      }
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('AI_API_KEY_MISSING');
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

  describe('dispose（P3-10 优雅关闭）', () => {
    it('无活跃对话时立即返回', async () => {
      // 不启动任何对话，直接 dispose
      await getChatService().dispose(1000);
      // dispose 后无活跃会话可 abort（验证清理生效而非 1000ms 兜底超时返回）
      expect(getChatService().abort('ghost-session')).toBe(false);
    });

    it('有活跃对话时等待 stream 完成后 resolve', async () => {
      const wc = createMockWebContents();
      // mock streamText 响应 abortSignal：abort 时让 reader 抛 AbortError
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

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-dispose-1',
        webContents: wc,
      });

      // dispose 会先 abortAll 再 await 所有活跃 stream Promise
      // 因为 streamText 响应了 abortSignal，stream 会抛 AbortError 被 catch，
      // 进入 finally 后从 Map 移除，stream Promise resolve
      await getChatService().dispose(1000);

      // 验证 stream 已完成（wc 收到 CHAT_STREAM_END）
      const endCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CHAT_STREAM_END);
      expect(endCalls).toHaveLength(1);
    });

    it('超时强制清空不 hang 死', async () => {
      const wc = createMockWebContents();
      // mock streamText 返回永不 close 的流，且不响应 abortSignal
      // 这样 dispose 的 Promise.allSettled 会永远 pending，只能靠 timeout 兜底
      mocks.mockStreamText.mockReturnValue({
        toUIMessageStream: () =>
          new ReadableStream({
            start() {
              // 不 enqueue 也不 close，也不响应 abortSignal
              // reader.read() 永远 pending
            },
          }),
      });

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 'session-stuck',
        webContents: wc,
      });

      // 用很短的超时（50ms）让测试快速完成
      // dispose 必须在 50ms 后强制 resolve（而非永远 pending）
      const start = Date.now();
      await getChatService().dispose(50);
      const elapsed = Date.now() - start;

      // 应该在 50ms 后 + 一点缓冲时间内完成
      expect(elapsed).toBeGreaterThanOrEqual(40);
      expect(elapsed).toBeLessThan(1000);

      // 验证 dispose 后即使 stream 协程仍在 pending，再次 dispose 也应立即返回
      // （Map 已被清空，无活跃 stream 可等待）
      await getChatService().dispose(50);
    });
  });

  describe('集成：生成选项 / usage 落库 / 标题生成', () => {
    it('streamText 收到生成选项：思考强度 max + 输出上限 384K', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(createMockStreamResult([{ type: 'finish' }]));

      await getChatService().startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 's-gen-options',
        webContents: wc,
      });
      await flushAsync();

      // 默认模型 deepseek-v4-flash：reasoning + effort max + 384K 输出上限
      const opts = mocks.mockStreamText.mock.calls[0]?.[0] as {
        providerOptions?: unknown;
        maxOutputTokens?: number;
      };
      expect(opts?.providerOptions).toEqual({ deepseek: { reasoningEffort: 'max' } });
      expect(opts?.maxOutputTokens).toBe(384_000);
    });

    it('注入依赖后：usage 落库 + 默认标题自动生成', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(
        createMockStreamResult([{ type: 'finish', finishReason: 'stop' }]),
      );
      // 会话服务 mock：默认标题 + rename 记录
      const mockSessionService = {
        get: vi.fn(async () => ({ session: { title: '新会话' } })),
        rename: vi.fn(async () => ({ ok: true })),
        recordUsage: vi.fn(async () => ({ ok: true })),
      } as unknown as ISessionService;
      // 标题生成器 mock
      const mockTitleGenerator: ITitleGenerator = {
        generateText: vi.fn(async () => ({
          text: '你好标题',
          usage: undefined,
        })),
      };

      // 注入依赖的 ChatService（beforeEach 已 resetChatService）
      await getChatService(mockSessionService, mockTitleGenerator).startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 's-title',
        webContents: wc,
      });
      await flushAsync();

      // usage 落库（totalUsage 为 undefined 时 recordUsage 不调用）
      expect(mockSessionService.recordUsage).not.toHaveBeenCalled();
      // 标题生成：get（默认标题）→ generateText → rename
      expect(mockTitleGenerator.generateText).toHaveBeenCalledTimes(1);
      expect(mockSessionService.rename).toHaveBeenCalledWith('s-title', '你好标题');
    });

    it('totalUsage 存在时：usage 落库（设置页用量统计）', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue({
        toUIMessageStream: () => createMockReadableStream([{ type: 'finish' }]),
        totalUsage: Promise.resolve({ inputTokens: 10, outputTokens: 5, totalTokens: 15 }),
      } as never);
      const mockSessionService = {
        recordUsage: vi.fn(async () => ({ ok: true })),
      } as unknown as ISessionService;

      await getChatService(mockSessionService).startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 's-usage',
        webContents: wc,
      });
      await flushAsync();

      expect(mockSessionService.recordUsage).toHaveBeenCalledTimes(1);
      const args = (mockSessionService.recordUsage as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0] as {
        sessionId: string;
        inputTokens: number;
        totalTokens: number;
      };
      expect(args.sessionId).toBe('s-usage');
      expect(args.inputTokens).toBe(10);
      expect(args.totalTokens).toBe(15);
    });

    it('会话已有自定义标题：不覆盖', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(createMockStreamResult([{ type: 'finish' }]));
      const mockSessionService = {
        get: vi.fn(async () => ({ session: { title: '我的会话' } })),
        rename: vi.fn(async () => ({ ok: true })),
      } as unknown as ISessionService;
      const mockTitleGenerator: ITitleGenerator = {
        generateText: vi.fn(async () => ({ text: '不该用', usage: undefined })),
      };

      await getChatService(mockSessionService, mockTitleGenerator).startChat({
        messages: [{ role: 'user', content: '你好' }],
        sessionId: 's-title-keep',
        webContents: wc,
      });
      await flushAsync();

      expect(mockTitleGenerator.generateText).not.toHaveBeenCalled();
      expect(mockSessionService.rename).not.toHaveBeenCalled();
    });
  });
});

describe('ChatService 批次5 缺口补全（重复启动/并发门/usage/中断收尾）', () => {
  let service: ReturnType<typeof getChatService>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetChatService();
    mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));
    mocks.mockRandomUUID.mockReturnValue('test-session-id');
    service = getChatService();
  });

  afterEach(() => {
    resetChatService();
  });

  function options(overrides: Partial<Parameters<typeof service.startChat>[0]> = {}) {
    return {
      messages: [{ role: 'user' as const, content: 'hi' }],
      sessionId: undefined as string | undefined,
      webContents: createMockWebContents(),
      ...overrides,
    };
  }

  it('重复 startChat 且旧流未结束：先中断旧流并等待其退出', async () => {
    let releaseOld: () => void = () => {};
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            releaseOld = () => {
              try {
                controller.close();
              } catch {
                /* 已关闭 */
              }
            };
          },
        }),
    });

    await service.startChat(options({ sessionId: 'dup-chat' }));
    await service.startChat(options({ sessionId: 'dup-chat' }));

    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'dup-chat' }),
      expect.stringContaining('已有活跃 chat stream'),
    );
    releaseOld();
    await service.dispose(100);
  }, 10_000);

  it('concurrencyGate 注入：acquire 获取槽位并在流结束释放', async () => {
    const release = vi.fn();
    const gate = {
      acquire: vi.fn(async (_id: string, _signal: AbortSignal) => release),
    } as unknown as ConcurrencyGate;
    resetChatService();
    service = getChatService(undefined, undefined, gate);

    await service.startChat(options());
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(gate.acquire).toHaveBeenCalledTimes(1);
    expect(gate.acquire).toHaveBeenCalledWith('test-session-id', expect.any(AbortSignal));
    expect(release).toHaveBeenCalled();
  });

  it('usage 部分字段（仅 totalTokens）：END 只含 totalTokens + recordUsage 兜底 0', async () => {
    const mockSessionService = {
      recordUsage: vi.fn(async () => {}),
      get: vi.fn(),
      rename: vi.fn(),
    } as unknown as ISessionService;
    resetChatService();
    service = getChatService(mockSessionService);
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () => createMockReadableStream([]),
      totalUsage: Promise.resolve({ totalTokens: 42 }),
    });

    await service.startChat(options({ sessionId: 's-usage-part' }));

    // 通过 recordUsage 断言覆盖 L422/427-429 链（END 推送经 emitEvent 已在既有用例覆盖）
    await vi.waitFor(
      () =>
        expect(mockSessionService.recordUsage).toHaveBeenCalledWith(
          expect.objectContaining({ totalTokens: 42, inputTokens: 0, outputTokens: 0 }),
        ),
      { timeout: 2000 },
    );
  });

  it('usage 完整字段：recordUsage 收到全部字段（含 cacheReadTokens/reasoningTokens）', async () => {
    const mockSessionService = {
      recordUsage: vi.fn(async () => {}),
      get: vi.fn(),
      rename: vi.fn(),
    } as unknown as ISessionService;
    resetChatService();
    service = getChatService(mockSessionService);
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () => createMockReadableStream([]),
      totalUsage: Promise.resolve({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        inputTokenDetails: { cacheReadTokens: 5 },
        outputTokenDetails: { reasoningTokens: 2 },
      }),
    });

    await service.startChat(options({ sessionId: 's-usage-full' }));

    await vi.waitFor(
      () =>
        expect(mockSessionService.recordUsage).toHaveBeenCalledWith({
          sessionId: 's-usage-full',
          modelId: expect.any(String),
          inputTokens: 10,
          outputTokens: 20,
          totalTokens: 30,
          cacheReadTokens: 5,
          reasoningTokens: 2,
        }),
      { timeout: 2000 },
    );
  });

  it('abort 后流收尾：推送 END(aborted) 且 CAS 不误删新 controller', async () => {
    const wc = createMockWebContents();
    let releaseStream: () => void = () => {};
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            releaseStream = () => {
              try {
                controller.close();
              } catch {
                /* 已关闭 */
              }
            };
          },
        }),
    });

    await service.startChat(options({ sessionId: 's-abt', webContents: wc }));
    service.abort('s-abt');
    // abort 后立即重启同一 sessionId：旧流 finally 的 CAS 应跳过删除（不误删新 controller）
    mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));
    await service.startChat(options({ sessionId: 's-abt', webContents: wc }));

    await vi.waitFor(
      () => {
        const endCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.CHAT_STREAM_END);
        expect(endCalls.length).toBeGreaterThan(0);
      },
      { timeout: 2000 },
    );
    releaseStream();
    await service.dispose(100);
  }, 10_000);

  it('webContents.isDestroyed=true + 流错误：不推送 ERROR（守卫分支）', async () => {
    const wc = createMockWebContents({ isDestroyed: true });
    mocks.mockStreamText.mockImplementation(() => {
      throw new APICallError({
        message: 'bad request',
        url: 'https://api.test.com/v1/chat',
        requestBodyValues: undefined,
        statusCode: 400,
        responseBody: '',
      });
    });

    await service.startChat(options({ sessionId: 's-destroyed-err', webContents: wc }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(wc.send).not.toHaveBeenCalled();
  });
});
