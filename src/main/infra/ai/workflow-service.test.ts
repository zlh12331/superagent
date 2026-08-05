// src/main/infra/ai/workflow-service.test.ts
// 工作流服务单测：创建/步骤状态机/预算软闸/日志/终端状态锁定

import { describe, expect, it } from 'vitest';
import { WorkflowService, WorkflowStepStatus } from './workflow-service';

describe('WorkflowService', () => {
  it('create：idle 状态 + 初始日志', () => {
    const service = new WorkflowService();
    const id = service.create('重构模块 A', 5);
    const run = service.get(id);
    expect(run?.status).toBe('idle');
    expect(run?.goal).toBe('重构模块 A');
    expect(run?.budgetSteps).toBe(5);
    expect(run?.journal).toHaveLength(1);
  });

  it('步骤生命周期：pending → running → completed（记录时间戳与输出）', () => {
    const service = new WorkflowService();
    const id = service.create('任务', 3);
    const stepId = service.addStep(id, '步骤 1');
    expect(stepId).not.toBeNull();

    const pending = service.get(id)?.steps[0];
    expect(pending?.status).toBe('pending');

    service.startStep(id, stepId as string);
    const running = service.get(id)?.steps[0];
    expect(running?.status).toBe('running');
    expect(running?.startedAt).not.toBeNull();
    // idle → running（首次步骤开始）
    expect(service.get(id)?.status).toBe('running');

    service.completeStep(id, stepId as string, '完成输出');
    const completed = service.get(id)?.steps[0];
    expect(completed?.status).toBe('completed');
    expect(completed?.output).toBe('完成输出');
    expect(completed?.endedAt).not.toBeNull();
  });

  it('complete：全部步骤完成才允许；未完成抛错', () => {
    const service = new WorkflowService();
    const id = service.create('任务', 3);
    const s1 = service.addStep(id, '步骤 1') as string;
    const s2 = service.addStep(id, '步骤 2') as string;
    service.startStep(id, s1);
    service.completeStep(id, s1);

    // 步骤 2 未完成 → complete 抛错
    expect(() => service.complete(id)).toThrow('未完成步骤');
    service.completeStep(id, s2);
    service.complete(id);
    expect(service.get(id)?.status).toBe('completed');
  });

  it('fail：工作流失败记录错误', () => {
    const service = new WorkflowService();
    const id = service.create('任务', 3);
    service.fail(id, '模型超时');
    expect(service.get(id)?.status).toBe('failed');
    expect(service.get(id)?.journal.some((entry) => entry.includes('模型超时'))).toBe(true);
  });

  it('终端状态锁定：完成后 addStep / fail 无效', () => {
    const service = new WorkflowService();
    const id = service.create('任务', 3);
    service.fail(id);
    expect(service.addStep(id, '新步骤')).toBeNull();
    service.complete(id); // 不抛（幂等）
    expect(service.get(id)?.status).toBe('failed');
  });

  it('预算软闸：步骤数 ≥ 预算', () => {
    const service = new WorkflowService();
    const id = service.create('任务', 2);
    expect(service.isBudgetExhausted(id)).toBe(false);
    service.addStep(id, '步骤 1');
    service.addStep(id, '步骤 2');
    expect(service.isBudgetExhausted(id)).toBe(true);
  });

  it('list：创建时间倒序（同毫秒 id 兜底，确定性排序）', () => {
    const service = new WorkflowService();
    service.create('工作流 A', 3);
    service.create('工作流 B', 3);
    const runs = service.list();
    expect(runs).toHaveLength(2);
    // 倒序：后创建在前（createdAt 非升序）
    for (let i = 1; i < runs.length; i += 1) {
      expect(runs[i - 1]?.createdAt).toBeGreaterThanOrEqual(runs[i]?.createdAt as number);
    }
    // 稳定性：两次 list 结果一致
    expect(service.list().map((r) => r.id)).toEqual(runs.map((r) => r.id));
  });

  it('failStep：步骤失败记录错误说明', () => {
    const service = new WorkflowService();
    const id = service.create('任务', 3);
    const s1 = service.addStep(id, '步骤 1') as string;
    service.startStep(id, s1);
    service.failStep(id, s1, '步骤错误');
    const step = service.get(id)?.steps[0];
    expect(step?.status).toBe(WorkflowStepStatus.FAILED);
    expect(step?.output).toBe('步骤错误');
  });
});
