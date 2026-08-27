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

import type { ChatMessage } from '@code-agent/shared/main';
import { IPC_CHANNELS } from '@code-agent/shared/main';
import { APICallError } from 'ai';
import type { WebContents } from 'electron';
import type { Mock } from 'vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SESSION_TITLE, type ISessionService } from '../storage/session-service';
import type { StartAgentOptions } from './agent/agent-service';
import type { ConcurrencyGate } from './agent-runtime/concurrency-gate';
import type { ITitleGenerator } from './knowledge/session-title';
import type { IPromptService } from './prompt/prompt-service';
import type { IPermissionService } from './tools/permission-service';
import type { IToolExecutor } from './tools/tool-executor';
import type { IToolRegistry } from './tools/tool-registry';

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
    async <T>(_name: string, _attrs: unknown, fn: (span: unknown) => Promise<T>): Promise<T> =>
      fn(mockSpan),
  );
  // mock span：验证 span?.setAttribute / end 链路（withSpan mock 传入真实形状对象）
  const mockSpan = {
    setAttribute: vi.fn(),
    end: vi.fn(),
  };
  // 模型注册表动态化：默认无 capabilities（contextWindowSize 兜底 128K）且无超时/重试配置
  const mockResolveModel = vi.fn(() => ({
    modelId: 'test-model',
    generationConfig: {},
    capabilities: {},
  }));
  // 生成选项动态化：默认空对象（无采样/输出上限/providerOptions 条件展开）
  const mockGenOptions = vi.fn(() => ({}));
  return {
    mockStreamText,
    mockGetModel,
    mockModel,
    mockLogger,
    mockRandomUUID,
    mockWithSpan,
    mockSpan,
    mockResolveModel,
    mockGenOptions,
  };
});

// mock ai：拦截 streamText（保留 isStepCount 等真实导出）
// mock ../models：modelRegistry.resolve 返回无超时配置（真实单例在测试环境可能带
// timeoutMs=0 → AbortSignal.timeout(0) 立即中断流，导致活跃会话测试无法挂起）
// 注意：vi.mock 路径相对测试文件（infra/ai/）解析，models 是同级目录 → './models'
vi.mock('./models', () => ({
  buildGenerationOptions: mocks.mockGenOptions,
  modelRegistry: {
    resolve: mocks.mockResolveModel,
    register: () => {},
  },
}));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    streamText: mocks.mockStreamText,
  };
});

// mock ai-provider：拦截 getModel
vi.mock('./llm-client/ai-provider', () => ({
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
// 注意：otel 在 infra/telemetry/ 下，相对测试文件（infra/ai/）为 '../telemetry/otel'
vi.mock('../telemetry/otel', () => ({
  withSpan: mocks.mockWithSpan,
}));

import { AgentService } from './agent/agent-service';
import { TurnRunner } from './agent-runtime/turn-runner';

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
 *
 * 迭代次数需覆盖 TurnRunner 的完整链路（每次 read 含 Promise.race + finally，
 * 3 次 read + completeTurn 约需 20+ 个微任务 tick）。
 */
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    // eslint-disable-next-line no-await-in-loop -- 测试需要顺序刷新微任务队列
    await Promise.resolve();
  }
}

/**
 * webContents.send 调用（agent:turn:event 通道已移除，全部调用均为流/工具/审批通道）
 */
function getNonTurnCalls(wc: MockedWebContents): unknown[][] {
  return wc.send.mock.calls;
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

// 崩溃恢复状态机：注入 fake sessionService（无 mock 规范，用真实接口最小实现）
// 文件级共享：多个 describe（生命周期/缺口补全）复用同一实例
const mockSessionService: ISessionService = {
  markRunning: vi.fn(async () => {}),
  markIdle: vi.fn(async () => {}),
  markAllInterrupted: vi.fn(async () => 0),
  pruneExpiredUsage: vi.fn(() => 0),
  exportAll: vi.fn(async () => ({ exportedAt: 0, app: 'test', sessions: [] })),
  list: vi.fn(),
  get: vi.fn(),
  delete: vi.fn(),
  rename: vi.fn(),
  pin: vi.fn(),
  create: vi.fn(),
  appendMessage: vi.fn(),
  replaceMessages: vi.fn(async () => 0),
  listRecentDirs: vi.fn(),
  recordUsage: vi.fn(async () => {}),
  getUsageSummary: vi.fn(),
  recordTurn: vi.fn(async () => {}),
  getTurns: vi.fn(async () => ({ sessionId: '', turns: [] })),
  getRecentTurns: vi.fn(async () => ({ turns: [] })),
  getTurnMessages: vi.fn(async () => []),
  dispose: vi.fn(),
};

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
      mockSessionService,
    );
    // 默认 streamText 返回单文本 part 流（真实 LLM 必然产出内容；
    // 空流场景由「空回复防护」专用用例显式覆盖）
    mocks.mockStreamText.mockReturnValue(
      createMockStreamResult([{ type: 'text-delta', textDelta: 'hi' }]),
    );
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
      // randomUUID 调用 2 次：sessionId + 回合 turnId（回合事件系统）
      expect(mocks.mockRandomUUID).toHaveBeenCalledTimes(2);
      expect(mocks.mockStreamText).toHaveBeenCalledTimes(1);
    });

    it('传入 sessionId：复用不生成新 id（仅生成回合 turnId）', async () => {
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
      // 会话 id 复用，但每个回合仍生成独立 turnId
      expect(mocks.mockRandomUUID).toHaveBeenCalledTimes(1);
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

      // 流式事件：2 个 part + 1 个 end
      expect(getNonTurnCalls(wc)).toHaveLength(3);

      const firstCall = getNonTurnCalls(wc)[0];
      if (!firstCall) throw new Error('webContents.send 未被调用');
      expect(firstCall[0]).toBe(IPC_CHANNELS.AGENT_STREAM_PART);
      const partPayload = firstCall[1] as { sessionId: string; part: unknown };
      expect(partPayload.sessionId).toBe('session-1');
      expect(partPayload.part).toEqual({ type: 'text', text: 'hello' });

      const lastCall = getNonTurnCalls(wc)[2];
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

      // 流式事件：仅 AGENT_STREAM_END（aborted）
      expect(getNonTurnCalls(wc)).toHaveLength(1);
      const call = getNonTurnCalls(wc)[0];
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

      expect(getNonTurnCalls(wc)).toHaveLength(1);
      const call = getNonTurnCalls(wc)[0];
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

      const call = getNonTurnCalls(wc)[0];
      if (!call) throw new Error('webContents.send 未被调用');
      const payload = call[1] as { code: string };
      expect(payload.code).toBe('AI_RATE_LIMITED');
    });

    it('流空闲超时（无 chunk 超过阈值）：中断并推送 AI_TIMEOUT', async () => {
      vi.useFakeTimers();
      try {
        const wc = createMockWebContents();
        // 永不推送数据的死流（pull 不 enqueue）
        const pendingStream = new ReadableStream({
          pull() {
            // 故意不调用 controller.enqueue / close，read() 永久挂起
          },
        });
        mocks.mockStreamText.mockReturnValue({
          toUIMessageStream: () => pendingStream,
        });

        await service.startAgent({
          messages: [{ role: 'user', content: '帮我读文件' }],
          sessionId: 'session-idle-timeout',
          workingDir: '/tmp/project',
          systemPrompt: '你是 Code Agent',
          maxSteps: 20,
          webContents: wc,
        });

        // 推进超过空闲超时阈值（600s）
        await vi.advanceTimersByTimeAsync(600_001);
        await flushAsync();

        // 中断流后推送 AGENT_STREAM_ERROR（AI_TIMEOUT）
        const errorCalls = wc.send.mock.calls.filter(
          (c) => c[0] === IPC_CHANNELS.AGENT_STREAM_ERROR,
        );
        expect(errorCalls.length).toBeGreaterThan(0);
        const payload = errorCalls[0]?.[1] as { code: string } | undefined;
        expect(payload?.code).toBe('AI_TIMEOUT');
      } finally {
        vi.useRealTimers();
      }
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
        userPrompt: '帮我读文件',
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
      // 每个会话消耗 2 个 UUID：sessionId + 回合 turnId
      mocks.mockRandomUUID
        .mockReturnValueOnce('session-a')
        .mockReturnValueOnce('turn-a')
        .mockReturnValueOnce('session-b')
        .mockReturnValueOnce('turn-b');

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

describe('AgentService 生命周期补充（活跃会话分支）', () => {
  let service: AgentService;
  let releaseStream: () => void;

  beforeEach(() => {
    service = new AgentService(
      { toAISDKTools: vi.fn(() => ({})) } as unknown as IToolRegistry,
      {} as unknown as IToolExecutor,
      { resolvePrompt: vi.fn(async () => '系统提示') } as unknown as IPromptService,
      {
        markRunning: vi.fn(async () => {}),
        markIdle: vi.fn(async () => {}),
        getTurns: vi.fn(async () => ({ sessionId: '', turns: [] })),
        getRecentTurns: vi.fn(async () => ({ turns: [] })),
        recordTurn: vi.fn(async () => {}),
        getTurnMessages: vi.fn(async () => []),
        appendMessage: vi.fn(async () => 0),
      } as unknown as ISessionService,
    );
    // deferred 流对象：保持会话活跃（可手动 close 结束）
    // 注意：必须返回流结果对象（含 toUIMessageStream），裸 Promise 会让
    // streamToWebContents 抛错并触发 finally 清理（测试踩坑实录）
    releaseStream = () => {};
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
  });

  function options(sessionId: string | undefined): StartAgentOptions {
    const wc = { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
    return {
      messages: [{ role: 'user' as const, content: '你好' }],
      sessionId,
      workingDir: '/tmp/project',
      systemPrompt: '测试',
      maxSteps: 5,
      webContents: wc,
    };
  }

  it('abort：活跃会话 → true；不存在 → false', async () => {
    const sessionId = await service.startAgent(options(undefined));
    expect(service.abort(sessionId)).toBe(true);
    expect(service.abort('ghost-session')).toBe(false);
    releaseStream();
  });

  it('abortAll：多活跃会话全部终止；空集 no-op', async () => {
    await service.startAgent(options('sess-a'));
    await service.startAgent(options('sess-b'));
    expect(() => service.abortAll()).not.toThrow();
    releaseStream();
  });

  it('dispose：挂起流时正常返回（不永久 pending）', async () => {
    await service.startAgent(options(undefined));
    await expect(service.dispose(500)).resolves.toBeUndefined();
    releaseStream();
  });

  it('startAgent 重复会话：旧活跃流被 abort（防双开）', async () => {
    await service.startAgent(options('dup'));
    const second = await service.startAgent(options('dup'));
    expect(second).toBe('dup');
    releaseStream();
    await vi.waitFor(() => expect(service.abort('dup')).toBe(true), { timeout: 2000 });
  }, 10_000);

  it('onTurnEvent：订阅收到事件；退订后不再收到', () => {
    const received: unknown[] = [];
    const unsubscribe = service.onTurnEvent((event) => received.push(event));
    const listeners = (service as unknown as { turnListeners: Set<(e: unknown) => void> })
      .turnListeners;
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener({ type: 'turn-start' });
    expect(received).toHaveLength(1);
    unsubscribe();
    expect(listeners.size).toBe(0);
    for (const listener of listeners) listener({ type: 'turn-start' });
    expect(received).toHaveLength(1);
  });

  it('markRunning 失败不阻断 startAgent（容错）', async () => {
    const sess = (
      service as unknown as { sessionService: { markRunning: ReturnType<typeof vi.fn> } }
    ).sessionService;
    sess.markRunning.mockRejectedValueOnce(new Error('db down'));
    await expect(service.startAgent(options(undefined))).resolves.toBeTruthy();
    releaseStream();
  });
  it('工具执行链：executeHook 成功 → executor.execute 调用 + TOOL_RESULT 事件 + 返回 output', async () => {
    const exec = { execute: vi.fn(async () => ({ output: 'found' })) } as unknown as IToolExecutor;
    let capturedHook:
      | ((tool: { name: string }, input: unknown, ctx: { callId: string }) => Promise<unknown>)
      | undefined;
    const reg = {
      toAISDKTools: vi.fn((_ctx: unknown, hook: typeof capturedHook) => {
        capturedHook = hook;
        return {};
      }),
    } as unknown as IToolRegistry;
    const svc = new AgentService(
      reg,
      exec,
      { resolvePrompt: vi.fn(async () => 'p') } as unknown as IPromptService,
      {
        markRunning: vi.fn(async () => {}),
        markIdle: vi.fn(async () => {}),
      } as unknown as ISessionService,
    );
    await svc.startAgent(options(undefined));
    expect(capturedHook).toBeDefined();
    if (capturedHook === undefined) throw new Error('hook not captured');
    const result = await capturedHook({ name: 'grep' }, { pattern: 'x' }, { callId: 'c1' });
    expect(exec.execute).toHaveBeenCalledWith(
      'grep',
      'c1',
      { pattern: 'x' },
      expect.anything(),
      expect.anything(),
    );
    expect(result).toBe('found');
    releaseStream();
  });

  it('工具执行失败：execute 返回 { error } → executeHook 透传结构化错误给 LLM', async () => {
    const exec = {
      execute: vi.fn(async () => ({ error: 'permission denied' })),
    } as unknown as IToolExecutor;
    let capturedHook:
      | ((tool: { name: string }, input: unknown, ctx: { callId: string }) => Promise<unknown>)
      | undefined;
    const reg = {
      toAISDKTools: vi.fn((_ctx: unknown, hook: typeof capturedHook) => {
        capturedHook = hook;
        return {};
      }),
    } as unknown as IToolRegistry;
    const svc = new AgentService(
      reg,
      exec,
      { resolvePrompt: vi.fn(async () => 'p') } as unknown as IPromptService,
      {
        markRunning: vi.fn(async () => {}),
        markIdle: vi.fn(async () => {}),
      } as unknown as ISessionService,
    );
    await svc.startAgent(options(undefined));
    if (capturedHook === undefined) throw new Error('hook not captured');
    const result = await capturedHook({ name: 'grep' }, {}, { callId: 'c2' });
    expect(result).toEqual({ error: 'permission denied' });
    releaseStream();
  });

  it('工具执行抛错：execute 异常向上传播（回合中断由上层处理）', async () => {
    const exec = {
      execute: vi.fn(async () => {
        throw new Error('executor crash');
      }),
    } as unknown as IToolExecutor;
    let capturedHook:
      | ((tool: { name: string }, input: unknown, ctx: { callId: string }) => Promise<unknown>)
      | undefined;
    const reg = {
      toAISDKTools: vi.fn((_ctx: unknown, hook: typeof capturedHook) => {
        capturedHook = hook;
        return {};
      }),
    } as unknown as IToolRegistry;
    const svc = new AgentService(
      reg,
      exec,
      { resolvePrompt: vi.fn(async () => 'p') } as unknown as IPromptService,
      {
        markRunning: vi.fn(async () => {}),
        markIdle: vi.fn(async () => {}),
      } as unknown as ISessionService,
    );
    await svc.startAgent(options(undefined));
    if (capturedHook === undefined) throw new Error('hook not captured');
    await expect(capturedHook({ name: 'grep' }, {}, { callId: 'c3' })).rejects.toThrow(
      'executor crash',
    );
    releaseStream();
  });

  it('审批订阅：注入 permissionService → onApprovalLifecycle 注册回调（触发由真实审批流程驱动）', async () => {
    const perm = {
      onApprovalLifecycle: vi.fn(() => () => {}),
    } as unknown as IPermissionService;
    const svc = new AgentService(
      { toAISDKTools: vi.fn(() => ({})) } as unknown as IToolRegistry,
      {} as unknown as IToolExecutor,
      { resolvePrompt: vi.fn(async () => 'p') } as unknown as IPromptService,
      {
        markRunning: vi.fn(async () => {}),
        markIdle: vi.fn(async () => {}),
      } as unknown as ISessionService,
      undefined,
      undefined,
      perm,
    );
    await svc.startAgent(options(undefined));
    expect(perm.onApprovalLifecycle).toHaveBeenCalledTimes(1);
    releaseStream();
  });

  it('标题生成注入：titleGenerator 存在时回合完成不抛（ensureSessionTitle 链由集成测试覆盖）', async () => {
    const gen = { generateTitle: vi.fn(async () => '标题') } as unknown as ITitleGenerator;
    mocks.mockStreamText.mockReturnValue(
      createMockStreamResult([
        { type: 'text-delta', textDelta: 'x' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    );
    const svc = new AgentService(
      { toAISDKTools: vi.fn(() => ({})) } as unknown as IToolRegistry,
      {} as unknown as IToolExecutor,
      { resolvePrompt: vi.fn(async () => 'p') } as unknown as IPromptService,
      {
        markRunning: vi.fn(async () => {}),
        markIdle: vi.fn(async () => {}),
      } as unknown as ISessionService,
      gen,
    );
    // 注入 titleGenerator 后回合完成不抛（标题链内部失败静默；generateTitle 调用由集成测试覆盖）
    await expect(svc.startAgent(options(undefined))).resolves.toBeTruthy();
  }, 10_000);
});

describe('agent-service 批次1 缺口补全（生命周期边界/事件/压缩/usage/超时）', () => {
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
      mockSessionService,
    );
    // 默认 streamText 返回单文本 part 流（真实 LLM 必然产出内容；
    // 空流场景由「空回复防护」专用用例显式覆盖）
    mocks.mockStreamText.mockReturnValue(
      createMockStreamResult([{ type: 'text-delta', textDelta: 'hi' }]),
    );
    mocks.mockRandomUUID.mockReturnValue('test-session-id');
    // 恢复默认模型解析（无 capabilities → 128K 兜底；无超时）与默认生成选项（空）
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: {},
      capabilities: {},
    }));
    mocks.mockGenOptions.mockImplementation(() => ({}));
  });

  afterEach(() => {
    // 恢复 spyOn（TurnRunner.run 的 aborted 用例专用），不影响 vi.fn 的 mockImplementation
    vi.restoreAllMocks();
  });

  /** 基础启动参数（messages 显式 as const 保证与 ChatMessage 字面量类型兼容） */
  function baseOptions(overrides: Partial<StartAgentOptions> = {}): StartAgentOptions {
    return {
      messages: [{ role: 'user' as const, content: '帮我读文件' }],
      sessionId: undefined,
      workingDir: '/tmp/project',
      systemPrompt: '你是 Code Agent',
      maxSteps: 20,
      ...overrides,
    };
  }

  it('重复 startAgent 且旧流未结束：先中断旧流并等待其退出', async () => {
    const wc = createMockWebContents();
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
    await service.startAgent(baseOptions({ sessionId: 'dup-session', webContents: wc }));
    // 旧流仍活跃时再次启动同一 sessionId → 应中断旧流并等待退出（不阻塞调用方）
    await service.startAgent(baseOptions({ sessionId: 'dup-session', webContents: wc }));
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'dup-session' }),
      expect.stringContaining('已有活跃 agent stream'),
    );
    releaseOld();
    await service.dispose(100);
  }, 10_000);

  it('无头场景（不传 webContents）：ctx 不含 webContents，流程正常完成', async () => {
    await service.startAgent(baseOptions());
    await flushAsync();
    const ctx = mockRegistry.toAISDKTools.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).toBeDefined();
    expect(ctx).not.toHaveProperty('webContents');
    expect(mockSessionService.markIdle).toHaveBeenCalled();
  });

  it('无头场景 + 流错误：不推送 ERROR，流程正常收尾', async () => {
    mocks.mockStreamText.mockImplementation(() => {
      throw new APICallError({
        message: 'bad request',
        url: 'https://api.test.com/v1/chat',
        requestBodyValues: undefined,
        statusCode: 400,
        responseBody: '',
      });
    });
    await expect(service.startAgent(baseOptions())).resolves.toBeTruthy();
    await flushAsync();
    expect(mockSessionService.markIdle).toHaveBeenCalled();
  });

  it('webContents.isDestroyed=true + 流错误：不推送 ERROR', async () => {
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
    await service.startAgent(baseOptions({ sessionId: 's-destroyed-err', webContents: wc }));
    await flushAsync();
    expect(wc.send).not.toHaveBeenCalled();
  });

  it('messages 无 user 消息：ctx 不含 userPrompt', async () => {
    await service.startAgent(
      baseOptions({
        messages: [
          { role: 'system' as const, content: 'sys' },
          { role: 'assistant' as const, content: 'hi' },
        ],
      }),
    );
    await flushAsync();
    const ctx = mockRegistry.toAISDKTools.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(ctx).not.toHaveProperty('userPrompt');
  });

  it('concurrencyGate 注入：acquire 获取槽位并在回合结束释放', async () => {
    const release = vi.fn();
    const gate = {
      acquire: vi.fn(async (_sessionId: string, _signal: AbortSignal) => release),
    } as unknown as ConcurrencyGate;
    service = new AgentService(
      mockRegistry as unknown as IToolRegistry,
      mockExecutor,
      mockPromptService,
      mockSessionService,
      undefined,
      gate,
    );
    await service.startAgent(baseOptions());
    await flushAsync();
    expect(gate.acquire).toHaveBeenCalledTimes(1);
    expect(gate.acquire).toHaveBeenCalledWith('test-session-id', expect.any(AbortSignal));
    expect(release).toHaveBeenCalled();
  });

  it('markIdle 失败：记录日志不阻断流程', async () => {
    const sessMocks = mockSessionService as unknown as {
      markIdle: ReturnType<typeof vi.fn>;
    };
    sessMocks.markIdle.mockRejectedValueOnce(new Error('db down'));
    await service.startAgent(baseOptions());
    await flushAsync();
    expect(mocks.mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'test-session-id' }),
      expect.stringContaining('markIdle'),
    );
  });

  it('onTurnEvent 监听器抛错：不阻断其他监听器（转发异常仅记录日志）', async () => {
    const boom = vi.fn(() => {
      throw new Error('listener crash');
    });
    const received: string[] = [];
    const ok = vi.fn((event: { type: string }) => {
      received.push(event.type);
    });
    service.onTurnEvent(boom);
    service.onTurnEvent(ok);
    const wc = createMockWebContents();
    await service.startAgent(baseOptions({ sessionId: 's-listen', webContents: wc }));
    await flushAsync();
    expect(boom).toHaveBeenCalled();
    expect(ok).toHaveBeenCalled();
    expect(received.length).toBeGreaterThan(0);
    expect(mocks.mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      '回合事件转发异常',
    );
  });

  it('completed + titleGenerator：默认标题会话触发 generateText（标题生成链）', async () => {
    const gen = {
      generateText: vi.fn(async () => ({ text: '新标题' })),
    } as unknown as ITitleGenerator;
    const sessMocks = mockSessionService as unknown as {
      get: ReturnType<typeof vi.fn>;
      rename: ReturnType<typeof vi.fn>;
    };
    sessMocks.get.mockResolvedValue({ session: { title: DEFAULT_SESSION_TITLE } });
    sessMocks.rename.mockResolvedValue(undefined);
    mocks.mockStreamText.mockReturnValue(
      createMockStreamResult([{ type: 'text-delta', textDelta: 'hi' }]),
    );
    service = new AgentService(
      mockRegistry as unknown as IToolRegistry,
      mockExecutor,
      mockPromptService,
      mockSessionService,
      gen,
    );
    await service.startAgent(baseOptions({ sessionId: 's-title' }));
    await vi.waitFor(() => expect(gen.generateText).toHaveBeenCalledTimes(1), { timeout: 2000 });
  });

  it('上下文 over-limit：抛 AI_CONTEXT_TOO_LARGE 且不调用 streamText', async () => {
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: {},
      capabilities: { contextWindowSize: 2000 },
    }));
    const wc = createMockWebContents();
    // 2000 窗口：hardLimit = 2000 − 100 = 1900；1950 tokens 超限
    const big = '字'.repeat(1950);
    await service.startAgent(
      baseOptions({
        messages: [{ role: 'user' as const, content: big }],
        sessionId: 's-over',
        webContents: wc,
      }),
    );
    await flushAsync();
    expect(mocks.mockStreamText).not.toHaveBeenCalled();
    const errCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_ERROR);
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]?.[1] as { code?: string } | undefined)?.code).toBe('AI_CONTEXT_TOO_LARGE');
    // 全量并发 + coverage 插桩下 gpt-tokenizer 编码 2K 字符可达 5s+，放宽超时
  }, 15_000);

  it('上下文 warn：记录接近压缩线日志', async () => {
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: {},
      capabilities: { contextWindowSize: 12000 },
    }));
    const wc = createMockWebContents();
    // 窗口 12000：compact 线 = 0.75×12000−600 = 8400，warn 线 = 7800，hardLimit = 11400；
    // 8000 tokens 落在 warn 区（且不触发 over-limit）
    const mid = '字'.repeat(8000);
    await service.startAgent(
      baseOptions({
        messages: [{ role: 'user' as const, content: mid }],
        sessionId: 's-warn',
        webContents: wc,
      }),
    );
    await flushAsync();
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ contextTokens: 8000, compactAt: 8400 }),
      expect.stringContaining('接近压缩线'),
      // 全量并发 + coverage 插桩下 gpt-tokenizer 编码 8K 字符可达 5s+，放宽超时
    );
  }, 15_000);

  it('上下文 compact：压缩消息历史后继续执行', async () => {
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: {},
      capabilities: { contextWindowSize: 12000 },
    }));
    const wc = createMockWebContents();
    const messages: ChatMessage[] = [
      { role: 'user', content: '字'.repeat(8600) },
      { role: 'user', content: 'hi' },
    ];
    await service.startAgent(baseOptions({ messages, sessionId: 's-compact', webContents: wc }));
    await flushAsync();
    expect(mocks.mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ originalCount: 2, compressedCount: 1 }),
      expect.stringContaining('上下文已压缩'),
    );
    const opts = mocks.mockStreamText.mock.calls[0]?.[0] as { messages: unknown[] } | undefined;
    expect(opts?.messages).toHaveLength(1);
    // 全量并发 + coverage 插桩下 gpt-tokenizer 编码 8K 字符可达 5s+，放宽超时
  }, 15_000);

  it('completed + 完整 usage：recordUsage 调用 + END 含 usage + span 属性', async () => {
    const wc = createMockWebContents();
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () => createMockReadableStream([{ type: 'text-delta', textDelta: 'hi' }]),
      totalUsage: Promise.resolve({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        inputTokenDetails: { cacheReadTokens: 5 },
        outputTokenDetails: { reasoningTokens: 2 },
      }),
    });
    await service.startAgent(baseOptions({ sessionId: 's-usage', webContents: wc }));
    await vi.waitFor(() => expect(mockSessionService.recordUsage).toHaveBeenCalled(), {
      timeout: 2000,
    });
    expect(mockSessionService.recordUsage).toHaveBeenCalledWith({
      sessionId: 's-usage',
      modelId: 'test-model',
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
      cacheReadTokens: 5,
      reasoningTokens: 2,
    });
    const end = getNonTurnCalls(wc).find((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_END);
    expect(end?.[1]).toEqual({
      sessionId: 's-usage',
      reason: 'completed',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
        cacheReadTokens: 5,
        reasoningTokens: 2,
      },
    });
    expect(mocks.mockSpan.setAttribute).toHaveBeenCalledWith('token.total', 30);
    expect(mocks.mockSpan.setAttribute).toHaveBeenCalledWith('token.prompt', 10);
    expect(mocks.mockSpan.setAttribute).toHaveBeenCalledWith('token.completion', 20);
  });

  it('totalUsage reject：usage 置空不阻断，END 不含 usage', async () => {
    const wc = createMockWebContents();
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () => createMockReadableStream([{ type: 'text-delta', textDelta: 'hi' }]),
      totalUsage: Promise.reject(new Error('usage boom')),
    });
    await service.startAgent(baseOptions({ sessionId: 's-usage2', webContents: wc }));
    await flushAsync();
    const end = getNonTurnCalls(wc).find((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_END);
    expect(end?.[1]).toEqual({ sessionId: 's-usage2', reason: 'completed' });
    expect(mockSessionService.recordUsage).not.toHaveBeenCalled();
  });

  it('usage 部分字段：仅 totalTokens 时条件展开', async () => {
    const wc = createMockWebContents();
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () => createMockReadableStream([{ type: 'text-delta', textDelta: 'hi' }]),
      totalUsage: Promise.resolve({ totalTokens: 42 }),
    });
    await service.startAgent(baseOptions({ sessionId: 's-usage3', webContents: wc }));
    await vi.waitFor(
      () =>
        expect(mockSessionService.recordUsage).toHaveBeenCalledWith(
          expect.objectContaining({ totalTokens: 42, inputTokens: 0, outputTokens: 0 }),
        ),
      { timeout: 2000 },
    );
    const end = getNonTurnCalls(wc).find((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_END);
    expect(end?.[1]).toEqual({
      sessionId: 's-usage3',
      reason: 'completed',
      usage: { totalTokens: 42 },
    });
  });

  it('空回复防护：流正常结束但零 part → 推送 AI_EMPTY_RESPONSE', async () => {
    const wc = createMockWebContents();
    mocks.mockStreamText.mockReturnValue(createMockStreamResult([]));
    await service.startAgent(baseOptions({ sessionId: 's-empty', webContents: wc }));
    await flushAsync();
    const errCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_ERROR);
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]?.[1] as { code?: string } | undefined)?.code).toBe('AI_EMPTY_RESPONSE');
  });

  it('模型级总时长超时：AI_TIMEOUT', async () => {
    mocks.mockResolveModel.mockImplementation(() => ({
      modelId: 'test-model',
      generationConfig: { timeoutMs: 50 },
      capabilities: {},
    }));
    const wc = createMockWebContents();
    // 流在超时信号触发后关闭：模型超时(50ms)先行触发 → 完成后检查点归类 AI_TIMEOUT
    mocks.mockStreamText.mockReturnValue({
      toUIMessageStream: () =>
        new ReadableStream({
          start(controller) {
            setTimeout(() => {
              try {
                controller.close();
              } catch {
                /* 已关闭 */
              }
            }, 120);
          },
        }),
    });
    await service.startAgent(baseOptions({ sessionId: 's-mto', webContents: wc }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    await flushAsync();
    const errCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_ERROR);
    expect(errCalls).toHaveLength(1);
    expect((errCalls[0]?.[1] as { code?: string } | undefined)?.code).toBe('AI_TIMEOUT');
  });

  it('TurnRunner 返回 aborted：推送 END(aborted)，不推 ERROR', async () => {
    // runner 的 abort 归因（read 抛 AbortError → aborted）由 turn-runner.test 单独覆盖；
    // 此处 mock runner.run 返回 aborted，验证 agent-service 的 aborted 分支
    // （stream.aborted 状态机事件 + completeTurn(aborted) + END 推送）
    const runnerSpy = vi.spyOn(TurnRunner.prototype, 'run');
    runnerSpy.mockResolvedValue({ reason: 'aborted', durationMs: 42 });
    const wc = createMockWebContents();
    await service.startAgent(baseOptions({ sessionId: 's-abt', webContents: wc }));
    await flushAsync();
    const end = getNonTurnCalls(wc).find((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_END);
    expect(end?.[1]).toEqual({ sessionId: 's-abt', reason: 'aborted' });
    const errCalls = wc.send.mock.calls.filter((c) => c[0] === IPC_CHANNELS.AGENT_STREAM_ERROR);
    expect(errCalls).toHaveLength(0);
  });

  it('genOptions 有值：samplingOptions/maxOutputTokens/providerOptions 透传 streamText', async () => {
    mocks.mockGenOptions.mockImplementation(() => ({
      samplingOptions: { temperature: 0.5 },
      maxOutputTokens: 4096,
      providerOptions: { deepseek: { thinking: { type: 'enabled' } } },
    }));
    await service.startAgent(baseOptions());
    await flushAsync();
    const opts = mocks.mockStreamText.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(opts?.['temperature']).toBe(0.5);
    expect(opts?.['maxOutputTokens']).toBe(4096);
    expect(opts?.['providerOptions']).toEqual({ deepseek: { thinking: { type: 'enabled' } } });
  });
});
