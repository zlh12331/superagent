import { describe, expect, it, vi } from 'vitest';

import type { SubagentManager } from './subagent-manager';
import { WorkflowService, WorkflowStatus } from './workflow-service';

function createFakeManager(): { run: ReturnType<typeof vi.fn>; manager: SubagentManager } {
  const run = vi.fn(async () => ({ output: '步骤产出', durationMs: 5 }));
  return { run, manager: { run } as unknown as SubagentManager };
}

describe('WorkflowService.runWorkflow（串行编排）', () => {
  it('成功路径：步骤按序委派 + 上一步产出注入下一步任务', async () => {
    const { run, manager } = createFakeManager();
    const service = new WorkflowService(manager);

    const result = await service.runWorkflow(
      '实现功能',
      [
        { name: '调研', task: '研究现有代码' },
        { name: '实现', task: '编写实现' },
      ],
      '/repo',
    );

    expect(result.status).toBe(WorkflowStatus.COMPLETED);
    expect(result.succeeded).toBe(2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[1]).not.toContain('步骤产出');
    expect(run.mock.calls[1]?.[1]).toContain('步骤产出');
    expect(result.steps[0]).toMatchObject({ name: '调研', success: true });
  });

  it('步骤失败（默认 halt）：FAILED + 后续步骤不执行', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ output: 'ok', durationMs: 1 })
      .mockRejectedValueOnce(new Error('子代理失败'))
      .mockResolvedValue({ output: '不应执行', durationMs: 1 });
    const service = new WorkflowService({ run } as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '目标',
      [
        { name: 's1', task: 't1' },
        { name: 's2', task: 't2' },
        { name: 's3', task: 't3' },
      ],
      '/repo',
    );

    expect(result.status).toBe(WorkflowStatus.FAILED);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.steps[1]).toMatchObject({ success: false });
  });

  it('onFailure=continue：失败后继续剩余步骤', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('第一步失败'))
      .mockResolvedValue({ output: '第二步产出', durationMs: 1 });
    const service = new WorkflowService({ run } as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '目标',
      [
        { name: 's1', task: 't1' },
        { name: 's2', task: 't2' },
      ],
      '/repo',
      { onFailure: 'continue' },
    );

    expect(result.status).toBe(WorkflowStatus.FAILED);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(run.mock.calls[1]?.[1]).toContain('第一步失败');
  });

  it('预算软闸：超出预算的步骤跳过', async () => {
    const { run, manager } = createFakeManager();
    const service = new WorkflowService(manager);

    const result = await service.runWorkflow(
      '目标',
      [
        { name: 's1', task: 't1' },
        { name: 's2', task: 't2' },
        { name: 's3', task: 't3' },
      ],
      '/repo',
      { budgetSteps: 2 },
    );

    expect(run).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(WorkflowStatus.COMPLETED);
    expect(result.steps).toHaveLength(2);
    expect(result.skipped).toBe(1);
  });
});
