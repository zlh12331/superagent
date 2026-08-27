// src/main/infra/ai/agent/workflow-service.test.ts
// WorkflowService 单测：串行编排（逐步委派 + 产出注入 + 预算/失败策略）
//
// 测试要点：
// 1. 串行成功：步骤按序委派，上一步产出注入下一步任务文本
// 2. 步骤失败（默认 halt）：工作流 FAILED，后续步骤不执行
// 3. onFailure=continue：失败后继续剩余步骤
// 4. 预算软闸：超预算步骤跳过

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
    // 第 1 步：不含注入；第 2 步：注入第 1 步产出
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
    expect(run).toHaveBeenCalledTimes(2); // 第 3 步未执行（halt）
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

    // continue 模式：执行完所有步骤，但存在失败步骤 → 整体 FAILED（设计语义）
    expect(result.status).toBe(WorkflowStatus.FAILED);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    // continue 模式下失败产出同样注入下一步（设计语义：失败原因供下一步参考）
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

    expect(run).toHaveBeenCalledTimes(2); // 第 3 步被预算跳过
    expect(result.status).toBe(WorkflowStatus.COMPLETED);
    expect(result.steps).toHaveLength(2); // 预算跳过的步骤不进入结果列表
    expect(result.skipped).toBe(1); // 跳过数显式统计
  });
});
