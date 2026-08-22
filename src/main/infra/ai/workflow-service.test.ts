// src/main/infra/ai/workflow-service.test.ts
// 工作流服务单测：创建/步骤状态机/预算软闸/日志/终端状态锁定 + runWorkflow 串行编排

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentManager } from './agent/subagent-manager';
import { WorkflowService, WorkflowStepStatus } from './agent/workflow-service';

const mocks = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  // taskService 为数据库外部依赖：mock 单例（阻断 better-sqlite3 加载链）
  const mockTaskService = {
    create: vi.fn(() => 'task-1'),
    update: vi.fn(),
  };
  return { mockLogger, mockTaskService };
});

vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

vi.mock('./agent/task-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agent/task-service')>();
  return {
    ...actual,
    taskService: mocks.mockTaskService,
  };
});

/** 创建 fake SubagentManager（run 可控；与 team-service.test 同款） */
function createFakeManager(): { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn() };
}

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

describe('WorkflowService.runWorkflow 串行编排', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('全部成功：终态 completed + 前一步产出注入下一步任务', async () => {
    const manager = createFakeManager();
    manager.run
      .mockResolvedValueOnce({ output: '方案结论', durationMs: 100, hasOutput: true })
      .mockResolvedValueOnce({ output: '实现完成', durationMs: 200, hasOutput: true });
    const service = new WorkflowService(manager as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '先设计后实现',
      [
        { name: '方案', task: '设计方案', agent: 'plan' },
        { name: '实现', task: '按方案实现' },
      ],
      '/tmp/proj',
    );

    expect(result.status).toBe('completed');
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    // 首步按声明 agent 委派；次步缺省 general 且注入上一步产出
    expect(manager.run).toHaveBeenNthCalledWith(1, 'plan', '设计方案', '/tmp/proj');
    const secondTask = String(manager.run.mock.calls[1]?.[1]);
    expect(secondTask).toContain('按方案实现');
    expect(secondTask).toContain('【上一步产出】');
    expect(secondTask).toContain('方案结论');
    // 状态机轨迹：journal 含步骤添加/running/completed 与工作流完成
    const run = service.get(result.runId);
    expect(run?.status).toBe('completed');
    expect(run?.steps.map((s) => s.status)).toEqual(['completed', 'completed']);
  });

  it('halt 失败策略（默认）：首步失败即终止，剩余步骤跳过', async () => {
    const manager = createFakeManager();
    manager.run.mockRejectedValueOnce(new Error('provider down'));
    const service = new WorkflowService(manager as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '三步依赖链',
      [
        { name: '步骤 1', task: '任务 1' },
        { name: '步骤 2', task: '任务 2' },
        { name: '步骤 3', task: '任务 3' },
      ],
      '/tmp/proj',
    );

    expect(manager.run).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.steps[0]?.output).toContain('provider down');
    expect(service.get(result.runId)?.status).toBe('failed');
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ step: '步骤 1' }),
      '工作流步骤执行失败',
    );
  });

  it('continue 失败策略：失败继续执行剩余步骤，终态 failed', async () => {
    const manager = createFakeManager();
    manager.run
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ output: '兜底产出', durationMs: 50, hasOutput: true });
    const service = new WorkflowService(manager as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '容错链',
      [
        { name: '易失败步', task: '任务 A' },
        { name: '后续步', task: '任务 B' },
      ],
      '/tmp/proj',
      { onFailure: 'continue' },
    );

    expect(manager.run).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(1);
    expect(result.status).toBe('failed');
    // continue 模式下失败信息同样传递给后续步骤感知
    const secondTask = String(manager.run.mock.calls[1]?.[1]);
    expect(secondTask).toContain('易失败步 失败：boom');
  });

  it('预算软闸：budgetSteps 小于声明步骤数时剩余跳过（预算内完成即 completed）', async () => {
    const manager = createFakeManager();
    manager.run.mockResolvedValue({ output: '产出', durationMs: 10, hasOutput: true });
    const service = new WorkflowService(manager as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '预算受限',
      [
        { name: '步骤 1', task: '任务 1' },
        { name: '步骤 2', task: '任务 2' },
        { name: '步骤 3', task: '任务 3' },
      ],
      '/tmp/proj',
      { budgetSteps: 2 },
    );

    expect(manager.run).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed');
    expect(result.skipped).toBe(1);
    expect(mocks.mockLogger.warn).not.toHaveBeenCalled();
    // journal 留痕预算耗尽
    const run = service.get(result.runId);
    expect(run?.journal.some((entry) => entry.includes('预算耗尽'))).toBe(true);
  });

  it('父回合已中断：取消工作流且所有步骤跳过', async () => {
    const manager = createFakeManager();
    const controller = new AbortController();
    controller.abort();
    const service = new WorkflowService(manager as unknown as SubagentManager);

    const result = await service.runWorkflow(
      '被中断',
      [{ name: '唯一步', task: '任务' }],
      '/tmp/proj',
      { abortSignal: controller.signal },
    );

    expect(manager.run).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
    expect(result.skipped).toBe(1);
    expect(service.get(result.runId)?.status).toBe('cancelled');
  });

  it('manager 未注入且模块单例未初始化：抛错提示初始化', async () => {
    const service = new WorkflowService();
    await expect(
      service.runWorkflow('目标', [{ name: '步骤', task: '任务' }], '/tmp/proj'),
    ).rejects.toThrow(/SubagentManager 未初始化/);
  });
});
