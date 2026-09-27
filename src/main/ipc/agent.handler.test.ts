// src/main/ipc/agent.handler.test.ts
// agent.handler 单测：run/stop（fake AgentService DI 注入）

import { type AppError, ErrorCode, MAX_USER_INPUT_HARD_CAP } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentHandlerDeps, createAgentHandlers } from './agent.handler';

/** 创建 fake AgentService */
function createFakeAgentService() {
  return {
    startAgent: vi.fn(async () => 'session-abc'),
    abort: vi.fn(() => true),
    abortAll: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as unknown as AgentHandlerDeps['agentService'];
}

/** 构造 ctx（run 需要 sender；isDestroyed/send 供 emitEvent 守卫与推送用） */
function createCtx() {
  return {
    sender: { id: 1, isDestroyed: () => false, send: vi.fn() },
    traceId: 'trace-1',
  } as never;
}

describe('agent.handler', () => {
  let agentService: ReturnType<typeof createFakeAgentService>;
  let handlers: ReturnType<typeof createAgentHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    agentService = createFakeAgentService();
    handlers = createAgentHandlers({ agentService });
  });

  it('run：转发完整入参并返回 sessionId', async () => {
    const input = {
      messages: [{ role: 'user' as const, content: 'hi' }],
      sessionId: undefined,
      workingDir: '/tmp/proj',
      systemPrompt: undefined,
      maxSteps: 20,
      mode: 'plan' as const,
      thinking: undefined,
      temperature: undefined,
    };
    const ctx = createCtx();
    const result = await handlers.run(input, ctx);
    expect(agentService.startAgent).toHaveBeenCalledWith({
      ...input,
      webContents: (ctx as { sender: unknown }).sender,
    });
    expect(result.sessionId).toBe('session-abc');
  });

  it('run：发起成功后推送 agent:stream:start（D4A：跨会话运行徽标点亮源）', async () => {
    const ctx = createCtx() as { sender: { send: ReturnType<typeof vi.fn> } };
    await handlers.run(
      {
        messages: [{ role: 'user' as const, content: 'hi' }],
        sessionId: undefined,
        workingDir: '/tmp/proj',
        systemPrompt: undefined,
        maxSteps: 20,
        mode: 'build' as const,
        thinking: undefined,
        temperature: undefined,
      },
      ctx as never,
    );
    // emitEvent → webContents.send(channel, payload)；channel 契约见 meta.ts
    const startCall = ctx.sender.send.mock.calls.find((c) => c[0] === 'agent:stream:start');
    expect(startCall).toBeDefined();
    expect(startCall?.[1]).toEqual({ sessionId: 'session-abc' });
  });

  it('run：最后一条用户消息超过主进程硬上限 → 拒绝且不启动 agent', async () => {
    const oversized = {
      messages: [{ role: 'user' as const, content: 'x'.repeat(MAX_USER_INPUT_HARD_CAP + 1) }],
      sessionId: undefined,
      workingDir: '/tmp/proj',
      systemPrompt: undefined,
      maxSteps: 20,
      mode: 'plan' as const,
      thinking: undefined,
      temperature: undefined,
    };
    await expect(handlers.run(oversized, createCtx())).rejects.toMatchObject({
      code: ErrorCode.INVALID_INPUT,
    } satisfies Partial<AppError>);
    expect(agentService.startAgent).not.toHaveBeenCalled();
  });

  it('stop：调用 abort 并返回结果', async () => {
    const result = await handlers.stop({ sessionId: 'session-x' }, {} as never);
    expect(agentService.abort).toHaveBeenCalledWith('session-x');
    expect(result.stopped).toBe(true);
  });
});
