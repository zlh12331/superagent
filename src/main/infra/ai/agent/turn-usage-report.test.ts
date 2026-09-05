// src/main/infra/ai/agent/turn-usage-report.test.ts
// usage 投影与遥测上报（纯函数 + fake 注入，无 mock 框架）

import { describe, expect, it, vi } from 'vitest';
import { projectTurnUsage, reportTurnUsage } from './turn-usage-report';

describe('projectTurnUsage', () => {
  it('null/undefined → undefined', () => {
    expect(projectTurnUsage(null)).toBeUndefined();
    expect(projectTurnUsage(undefined)).toBeUndefined();
  });

  it('全字段透传（含 cache/reasoning 明细）', () => {
    const usage = projectTurnUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { cacheReadTokens: 80 },
      outputTokenDetails: { reasoningTokens: 20 },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cacheReadTokens: 80,
      reasoningTokens: 20,
    });
  });

  it('部分字段：undefined 字段不进结果（条件展开语义）', () => {
    const usage = projectTurnUsage({
      inputTokens: 10,
      outputTokens: undefined,
      totalTokens: undefined,
    });
    expect(usage).toEqual({ inputTokens: 10 });
  });
});

describe('reportTurnUsage', () => {
  const baseDeps = () => ({
    recordUsage: vi.fn().mockResolvedValue(undefined),
    span: { setAttribute: vi.fn() },
  });

  it('usage 为 null 时不产生任何副作用', () => {
    const deps = baseDeps();
    reportTurnUsage(deps, { sessionId: 's1', modelId: 'm1', usage: null });
    expect(deps.recordUsage).not.toHaveBeenCalled();
    expect(deps.span.setAttribute).not.toHaveBeenCalled();
  });

  it('持久化收到归零兜底的计数字段与可选明细', async () => {
    const deps = baseDeps();
    reportTurnUsage(deps, {
      sessionId: 's1',
      modelId: 'deepseek-v4-flash',
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputTokenDetails: { cacheReadTokens: 80 },
      },
    });
    expect(deps.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 's1',
        modelId: 'deepseek-v4-flash',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        cacheReadTokens: 80,
      }),
    );
  });

  it('span 按 undefined 守卫逐字段打点', () => {
    const deps = baseDeps();
    reportTurnUsage(deps, {
      sessionId: 's1',
      modelId: 'm1',
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(deps.span.setAttribute).toHaveBeenCalledWith('token.total', 3);
    expect(deps.span.setAttribute).toHaveBeenCalledWith('token.prompt', 1);
    expect(deps.span.setAttribute).toHaveBeenCalledWith('token.completion', 2);
  });

  it('recordUsage 拒绝不冒泡（fire-and-forget，错误仅日志）', async () => {
    const deps = {
      recordUsage: vi.fn().mockRejectedValue(new Error('db down')),
      span: { setAttribute: vi.fn() },
    };
    reportTurnUsage(deps, {
      sessionId: 's1',
      modelId: 'm1',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    await vi.waitFor(() => expect(deps.recordUsage).toHaveBeenCalled());
    expect(deps.span.setAttribute).toHaveBeenCalled(); // 不被持久化失败阻断
  });
});
