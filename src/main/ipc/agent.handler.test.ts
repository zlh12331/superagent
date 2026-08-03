// src/main/ipc/agent.handler.test.ts
// agent.handler 单测：run/stop（fake AgentService DI 注入）

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

/** 构造 ctx（run 需要 sender） */
function createCtx() {
  return { sender: { id: 1 }, traceId: 'trace-1' } as never;
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
    };
    const result = await handlers.run(input, createCtx());
    expect(agentService.startAgent).toHaveBeenCalledWith({
      ...input,
      webContents: { id: 1 },
    });
    expect(result.sessionId).toBe('session-abc');
  });

  it('stop：调用 abort 并返回结果', async () => {
    const result = await handlers.stop({ sessionId: 'session-x' }, {} as never);
    expect(agentService.abort).toHaveBeenCalledWith('session-x');
    expect(result.stopped).toBe(true);
  });
});
