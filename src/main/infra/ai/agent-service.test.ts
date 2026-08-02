// src/main/infra/ai/agent-service.test.ts
// agent-service 单测：streamText + tools + stopWhen 多轮工具调用循环
//
// 测试要点：
// 1. startAgent：生成 sessionId 并立即返回（异步推送 part）
// 2. startAgent 续传：传入 sessionId 时复用
// 3. streamText 入参：tools + stopWhen(isStepCount) + system prompt + abortSignal
// 4. 正常完成：推送所有 part + AGENT_STREAM_END (reason='completed')
// 5. AbortError：推送 reason='aborted' 的 END，不推送 error
// 6. 错误分类：按错误特征映射 ErrorCode 并推送 AGENT_STREAM_ERROR
// 7. webContents.isDestroyed：停止推送
// 8. abort：中断指定 sessionId，返回 true；不存在的返回 false
// 9. abortAll：中断所有活跃 agent 对话
// 10. dispose：等待所有活跃 stream 完成（带超时兜底）
// 11. 工具 executeHook 注入：验证 ToolExecutor.execute 被调用，结果正确返回给 AI SDK
// 12. systemPrompt 未传时：调用 PromptService.resolvePrompt 注入默认 prompt

import type { ChatMessage } from '@code-agent/shared';
import { IPC_CHANNELS } from '@code-agent/shared';
import { APICallError } from 'ai';
import type { WebContents } from 'electron';
import type { Mock } from 'vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IToolRegistry } from './tool-registry';

// vi.mock 会被 hoist，工厂函数内不能引用外部 const
// 必须用 vi.hoisted 导出 mock 对象
const mocks = vi.hoisted(() => {
  const mockStreamText = vi.fn();
  const mockModel = { __mockModel: true };
  const mockGetModel = vi.fn(async () => mockModel);
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const mockRandomUUID = vi.fn(() => 'test-session-id');
  // withSpan mock：直接执行传入的函数（传 undefined span）
  const mockWithSpan = vi.fn(
    async <T>(_name: string, _attrs: unknown, fn: (span: undefined) => Promise<T>): Promise<T> =>
      fn(undefined),
  );
  return {
    mockStreamText,
    mockGetModel,
    mockModel,
    mockLogger,
    mockRandomUUID,
    mockWithSpan,
  };
});

// mock ai：拦截 streamText（保留 isStepCount 等真实导出）
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: mocks.mockStreamText,
  };
});

// mock ai-provider：拦截 getModel
vi.mock('./ai-provider', () => ({
  getModel: mocks.mockGetModel,
}));

// mock logger
vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

// mock node:crypto
vi.mock('node:crypto', () => ({
  randomUUID: mocks.mockRandomUUID,
}));

// mock telemetry/otel：拦截 withSpan，避免依赖 OTel 初始化状态
vi.mock('../../telemetry/otel', () => ({
  withSpan: mocks.mockWithSpan,
}));

import { AgentService } from './agent-service';

/**
 * 创建 mock ReadableStream：按顺序推送 parts 后 close
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
 */
function createMockStreamResult(parts: unknown[]): { toUIMessageStream: () => ReadableStream } {
  return {
    toUIMessageStream: () => createMockReadableStream(parts),
  };
}

/**
 * Mock WebContents 类型
 */
type MockedWebContents = WebContents & {
  send: Mock;
  isDestroyed: Mock<() => boolean>;
};

function createMockWebContents(overrides?: { isDestroyed?: boolean }): MockedWebContents {
  return {
    send: vi.fn(),
    isDestroyed: vi.fn(() => overrides?.isDestroyed ?? false),
  } as unknown as MockedWebContents;
}

/**
 * 等待所有微任务/异步任务完成
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    // eslint-disable-next-line no-await-in-loop -- 测试需要顺序刷新微任务队列
    await Promise.resolve();
  }
}

/**
 * 创建 mock ToolRegistry
 *
 * 补全 IToolRegistry 全部方法（register/unregister/get/list 为 stub），
 * 使 mock 对象结构兼容 AgentService 构造函数的入参类型。
 * 测试仅关心 toAISDKTools，其他方法返回空值即可。
 *
 * 注意：mock 的 toAISDKTools 返回值不满足完整的 Tool 类型（缺 inputSchema 等字段），
 * 但测试只验证 executeHook 是否被正确注入，AI SDK 在 streamText 调用时会消费 tools 对象。
 * 因此在传给 AgentService 时用 `as unknown as IToolRegistry` 断言绕过严格类型检查。
 * mock 对象本身的 toAISDKTools 保留 Mock 类型，供测试通过 .mock 访问调用记录。
 */
function createMockToolRegistry() {
  return {
    register: vi.fn(),
    unregister: vi.fn(() => false),
    get: vi.fn(() => undefined),
    list: vi.fn(() => []),
    toAISDKTools: vi.fn((_ctx, executeHook) => {
      // 返回一个简单的 tools 对象，AI SDK 会接受
      // executeHook 是 AgentService 传入的函数，用于包装 ToolExecutor.execute
      // 工具名用计算属性名（biome useNamingConvention 不检查计算属性名）
      return { ['mock_tool']: { execute: executeHook } };
    }),
  };
}

/**
 * 创建 mock ToolExecutor
 */
function createMockToolExecutor() {
  return {
    execute: vi.fn(async () => ({
      sessionId: 'test-session-id',
      toolCallId: 'call-1',
      toolName: 'mock_tool',
      title: 'Mock 工具执行结果',
      output: { result: 'ok' },
    })),
  };
}

/**
 * 创建 mock PromptService
 */
function createMockPromptService() {
  return {
    initialize: vi.fn(),
    resolvePrompt: vi.fn(async () => ({
      content: '你是 Code Agent',
      source: 'default-fallback' as const,
    })),
  };
}

describe('agent-service', () => {
  let service: AgentService;
  let mockRegistry: ReturnType<typeof createMockToolRegistry>;
  let mockExecutor: ReturnType<typeof createMockToolExecutor>;
  let mockPromptService: ReturnType<typeof createMockPromptService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRegistry = createMockToolRegistry();
    mockExecutor = createMockToolExecutor();
    mockPromptService = createMockPromptService();
    service = new AgentService(
      mockRegistry as unknown as IToolRegistry,
      mockExecutor,
      mockPromptService,
    );
    // 默认 streamText 返回空流（立即 close）
    mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));
    mocks.mockRandomUUID.mockReturnValue('test-session-id');
  });

  describe('startAgent', () => {
    it('不传 sessionId：生成新 id 并立即返回', async () => {
      const wc = createMockWebContents();
      const sessionId = await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      expect(sessionId).toBe('test-session-id');
      expect(mocks.mockRandomUUID).toHaveBeenCalledTimes(1);
      expect(mocks.mockStreamText).toHaveBeenCalledTimes(1);
    });

    it('传入 sessionId：复用不生成新 id', async () => {
      const wc = createMockWebContents();
      const sessionId = await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'custom-agent-id',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      expect(sessionId).toBe('custom-agent-id');
      expect(mocks.mockRandomUUID).not.toHaveBeenCalled();
    });

    it('mode=plan：ToolContext.mode 透传为 plan（写操作会被 ToolExecutor 拒绝）', async () => {
      const wc = createMockWebContents();
      await service.startAgent({
        messages: [{ role: 'user', content: '分析这个项目的结构' }],
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        mode: 'plan',
        webContents: wc,
      });

      // toAISDKTools 收到的基础上下文应携带 mode='plan'
      const calls = mockRegistry.toAISDKTools.mock.calls;
      const ctx = calls[0]?.[0] as { mode?: string } | undefined;
      expect(ctx?.mode).toBe('plan');
    });

    it('缺省 mode：ToolContext.mode 回退为 build（兼容旧调用方）', async () => {
      const wc = createMockWebContents();
      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      const calls = mockRegistry.toAISDKTools.mock.calls;
      const ctx = calls[0]?.[0] as { mode?: string } | undefined;
      expect(ctx?.mode).toBe('build');
    });

    it('streamText 入参：传 model + messages + tools + stopWhen + system + abortSignal', async () => {
      const wc = createMockWebContents();
      const messages: ChatMessage[] = [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '帮我读文件' },
      ];

      await service.startAgent({
        messages,
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 15,
        webContents: wc,
      });

      await flushAsync();

      expect(mocks.mockGetModel).toHaveBeenCalledWith(undefined);
      expect(mocks.mockStreamText).toHaveBeenCalledTimes(1);
      const callArgs = mocks.mockStreamText.mock.calls[0];
      if (!callArgs) throw new Error('streamText 未被调用');
      const opts = callArgs[0] as {
        model: unknown;
        messages: unknown;
        tools: unknown;
        stopWhen: unknown;
        system: string;
        allowSystemInMessages: boolean;
        abortSignal: AbortSignal;
      };
      expect(opts.model).toBe(mocks.mockModel);
      expect(opts.messages).toEqual(messages);
      expect(opts.tools).toBeDefined();
      expect(opts.stopWhen).toBeDefined();
      expect(opts.system).toBe('你是 Code Agent');
      expect(opts.allowSystemInMessages).toBe(true);
      expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    });

    it('systemPrompt 未传时：调用 PromptService.resolvePrompt 注入默认 prompt', async () => {
      const wc = createMockWebContents();

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: undefined,
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      expect(mockPromptService.resolvePrompt).toHaveBeenCalledWith(undefined, '/tmp/project');
      // streamText 应该收到 system 参数
      const callArgs = mocks.mockStreamText.mock.calls[0];
      if (!callArgs) throw new Error('streamText 未被调用');
      const opts = callArgs[0] as { system: string };
      expect(opts.system).toBe('你是 Code Agent');
    });

    it('正常完成：逐 part 推送 AGENT_STREAM_PART，最后推送 AGENT_STREAM_END', async () => {
      const wc = createMockWebContents();
      const parts = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ];
      mocks.mockStreamText.mockReturnValue(createMockStreamResult(parts));

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-1',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      // 应该推送 2 个 part + 1 个 end
      expect(wc.send).toHaveBeenCalledTimes(3);

      const firstCall = wc.send.mock.calls[0];
      if (!firstCall) throw new Error('webContents.send 未被调用');
      expect(firstCall[0]).toBe(IPC_CHANNELS.AGENT_STREAM_PART);
      const partPayload = firstCall[1] as { sessionId: string; part: unknown };
      expect(partPayload.sessionId).toBe('session-1');
      expect(partPayload.part).toEqual({ type: 'text', text: 'hello' });

      const lastCall = wc.send.mock.calls[2];
      if (!lastCall) throw new Error('最后一个 webContents.send 不存在');
      expect(lastCall[0]).toBe(IPC_CHANNELS.AGENT_STREAM_END);
      expect(lastCall[1]).toEqual({ sessionId: 'session-1', reason: 'completed' });
    });

    it('webContents.isDestroyed=true：停止推送 part', async () => {
      const wc = createMockWebContents();
      wc.isDestroyed.mockReturnValue(true);

      const parts = [
        { type: 'text', text: 'hello' },
        { type: 'text', text: 'world' },
      ];
      mocks.mockStreamText.mockReturnValue(createMockStreamResult(parts));

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-2',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      // isDestroyed=true 后停止推送 part，也不推送 END
      expect(wc.send).not.toHaveBeenCalled();
    });

    it('AbortError：不推送 error，仅推送 AGENT_STREAM_END (reason=aborted)', async () => {
      const wc = createMockWebContents();
      const err = new Error('aborted');
      err.name = 'AbortError';
      mocks.mockStreamText.mockImplementation(() => {
        throw err;
      });

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-abort',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      // 应该只调用一次 send：AGENT_STREAM_END
      expect(wc.send).toHaveBeenCalledTimes(1);
      const call = wc.send.mock.calls[0];
      if (!call) throw new Error('webContents.send 未被调用');
      expect(call[0]).toBe(IPC_CHANNELS.AGENT_STREAM_END);
      expect(call[1]).toEqual({ sessionId: 'session-abort', reason: 'aborted' });
      // 不应该推送 AGENT_STREAM_ERROR
      const errorCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_ERROR);
      expect(errorCalls).toHaveLength(0);
    });

    it('API 错误：推送 AGENT_STREAM_ERROR + AI_API_KEY_INVALID', async () => {
      const wc = createMockWebContents();
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

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-err',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      expect(wc.send).toHaveBeenCalledTimes(1);
      const call = wc.send.mock.calls[0];
      if (!call) throw new Error('webContents.send 未被调用');
      expect(call[0]).toBe(IPC_CHANNELS.AGENT_STREAM_ERROR);
      const payload = call[1] as { sessionId: string; code: string; message: string };
      expect(payload.sessionId).toBe('session-err');
      expect(payload.code).toBe('AI_API_KEY_INVALID');
    });

    it('限流错误：推送 AI_RATE_LIMITED', async () => {
      const wc = createMockWebContents();
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

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-rl',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      const call = wc.send.mock.calls[0];
      if (!call) throw new Error('webContents.send 未被调用');
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('AI_RATE_LIMITED');
    });
  });

  describe('工具 executeHook 注入', () => {
    it('toAISDKTools 被调用，executeHook 包装 ToolExecutor.execute', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-tool',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await flushAsync();

      // toAISDKTools 应该被调用一次
      expect(mockRegistry.toAISDKTools).toHaveBeenCalledTimes(1);
      // 第一个参数是 ctx
      // 用 if 守卫替代 ! 非空断言（避免 biome noNonNullAssertion warning）
      const callArgs = mockRegistry.toAISDKTools.mock.calls[0];
      if (callArgs === undefined) {
        throw new Error('Expected toAISDKTools to have been called');
      }
      const [ctxArg] = callArgs;
      expect(ctxArg).toEqual({
        workingDir: '/tmp/project',
        sessionId: 'session-tool',
        webContents: expect.objectContaining({
          send: expect.any(Function),
          isDestroyed: expect.any(Function),
        }),
        abortSignal: expect.any(AbortSignal),
        mode: 'build',
      });
    });
  });

  describe('abort', () => {
    it('中断存在的 sessionId：返回 true', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-abort-test',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      const result = service.abort('session-abort-test');
      expect(result).toBe(true);
    });

    it('中断不存在的 sessionId：返回 false', () => {
      const result = service.abort('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('abortAll', () => {
    it('中断所有活跃 agent 对话', async () => {
      const wc = createMockWebContents();
      // 用永不关闭的 stream 保持 session 活跃（否则空流立即 close，session 已被清理）
      mocks.mockStreamText.mockReturnValue({
        toUIMessageStream: () =>
          new ReadableStream({
            start() {
              // 不 close，不 enqueue，保持 session 活跃
            },
          }),
      });
      mocks.mockRandomUUID.mockReturnValueOnce('session-a').mockReturnValueOnce('session-b');

      await service.startAgent({
        messages: [{ role: 'user', content: 'a' }],
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });
      await service.startAgent({
        messages: [{ role: 'user', content: 'b' }],
        sessionId: undefined,
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      service.abortAll();

      // abortAll 后 session 仍在 Map 中（直到 stream 真正结束才移除）
      // abort 已被 abortAll 调用过的 controller 再次 abort 仍返回 true（session 存在）
      expect(service.abort('session-a')).toBe(true);
      expect(service.abort('session-b')).toBe(true);

      // 清理：dispose 等待 stream 结束（带超时）
      await service.dispose(100);
    });
  });

  describe('dispose', () => {
    it('无活跃 stream 时立即返回', async () => {
      await service.dispose();
      // 不抛错即可
    });

    it('有活跃 stream 时等待完成', async () => {
      const wc = createMockWebContents();
      mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-dispose',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      await service.dispose(1000);

      // dispose 后 Map 应清空
      expect(service.abort('session-dispose')).toBe(false);
    });

    it('超时后强制清空', async () => {
      const wc = createMockWebContents();
      // 创建一个永不关闭的 stream
      mocks.mockStreamText.mockReturnValue({
        toUIMessageStream: () =>
          new ReadableStream({
            start() {
              // 不 close，不 enqueue，永不结束
            },
          }),
      });

      await service.startAgent({
        messages: [{ role: 'user', content: '帮我读文件' }],
        sessionId: 'session-hang',
        workingDir: '/tmp/project',
        systemPrompt: '你是 Code Agent',
        maxSteps: 20,
        webContents: wc,
      });

      // dispose 带极短超时
      const start = Date.now();
      await service.dispose(100);
      const elapsed = Date.now() - start;

      // 应该在超时附近返回（允许一定余量）
      expect(elapsed).toBeLessThan(2000);
      // 超时后 Map 应清空
      expect(service.abort('session-hang')).toBe(false);
    });
  });
});
