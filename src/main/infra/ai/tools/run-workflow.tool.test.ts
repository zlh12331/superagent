// src/main/infra/ai/tools/run-workflow.tool.test.ts
// run_workflow 工具单测：入参 schema 校验 + 结果渲染 + 失败兜底（service 单例 mock）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunWorkflowTool } from './run-workflow.tool';
import type { ToolContext } from './tool';

const mocks = vi.hoisted(() => ({
  runWorkflow: vi.fn(),
}));

vi.mock('../agent/workflow-service', () => ({
  workflowService: { runWorkflow: mocks.runWorkflow },
}));

function createCtx(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: '/tmp/proj',
    sessionId: 'session-1',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    mode: 'build',
    ...overrides,
  };
}

describe('run_workflow 工具', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功执行：透传入参（含条件展开 onFailure）+ 渲染状态行与步骤结果', async () => {
    mocks.runWorkflow.mockResolvedValueOnce({
      runId: 'wf-1',
      status: 'completed',
      succeeded: 2,
      failed: 0,
      skipped: 0,
      steps: [
        { name: '方案', agent: 'plan', success: true, output: '方案结论', durationMs: 1000 },
        { name: '实现', agent: 'general', success: true, output: '实现完成', durationMs: 2000 },
      ],
    });
    const tool = createRunWorkflowTool();

    const result = await tool.execute(
      {
        goal: '先设计后实现',
        steps: [
          { name: '方案', task: '设计方案', agent: 'plan' },
          { name: '实现', task: '按方案实现' },
        ],
      },
      createCtx(),
    );

    expect(mocks.runWorkflow).toHaveBeenCalledTimes(1);
    const [goal, steps, workDir, options] = mocks.runWorkflow.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      Record<string, unknown>,
    ];
    expect(goal).toBe('先设计后实现');
    expect(steps).toHaveLength(2);
    expect(workDir).toBe('/tmp/proj');
    // 未传 onFailure：不携带该键（exactOptionalPropertyTypes 条件展开）
    expect('onFailure' in (options ?? {})).toBe(false);

    expect(result.title).toContain('完成');
    expect(result.output).toContain('成功 2 / 失败 0 / 跳过 0');
    expect(result.output).toContain('✅ 方案');
    expect(result.output).toContain('方案结论');
    expect(result.output).not.toContain('未执行');
  });

  it('onFailure 显式传入时透传；skipped 步骤渲染提示行', async () => {
    mocks.runWorkflow.mockResolvedValueOnce({
      runId: 'wf-2',
      status: 'completed',
      succeeded: 1,
      failed: 0,
      skipped: 1,
      steps: [{ name: '步骤 1', agent: 'general', success: true, output: '产出', durationMs: 10 }],
    });
    const tool = createRunWorkflowTool();

    const result = await tool.execute(
      {
        goal: '预算受限',
        steps: [
          { name: '步骤 1', task: '任务 1' },
          { name: '步骤 2', task: '任务 2' },
        ],
        onFailure: 'continue',
      },
      createCtx(),
    );

    const options = mocks.runWorkflow.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(options?.['onFailure']).toBe('continue');
    expect(result.output).toContain('1 个步骤未执行');
  });

  it('service 抛错：返回失败 ToolResult（不向模型抛异常）', async () => {
    mocks.runWorkflow.mockRejectedValueOnce(new Error('SubagentManager 未初始化'));
    const tool = createRunWorkflowTool();

    const result = await tool.execute(
      { goal: '目标', steps: [{ name: '步骤', task: '任务' }] },
      createCtx(),
    );

    expect(result.title).toBe('工作流执行失败');
    expect(result.output).toContain('SubagentManager 未初始化');
  });

  it('非 completed 终态标题区分（failed）', async () => {
    mocks.runWorkflow.mockResolvedValueOnce({
      runId: 'wf-3',
      status: 'failed',
      succeeded: 0,
      failed: 1,
      skipped: 0,
      steps: [
        {
          name: '步骤 1',
          agent: 'general',
          success: false,
          output: '步骤执行失败：boom',
          durationMs: 5,
        },
      ],
    });
    const tool = createRunWorkflowTool();

    const result = await tool.execute(
      { goal: '目标', steps: [{ name: '步骤 1', task: '任务' }] },
      createCtx(),
    );

    expect(result.title).toContain('结束');
    expect(result.output).toContain('成功 0 / 失败 1 / 跳过 0');
    expect(result.output).toContain('❌ 步骤 1');
  });
});
