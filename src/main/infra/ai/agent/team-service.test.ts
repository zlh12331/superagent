// src/main/infra/ai/agent/team-service.test.ts
// TeamService 单测：并行委派 / 失败隔离 / leader 汇总
//
// 测试要点：
// 1. runTeam 全部成功：成员结果 + succeeded/failed 计数
// 2. 失败隔离：单成员 reject → success=false + 错误信息，不阻断其他成员
// 3. leader 汇总：默认 general / 自定义 agent / 无输出兜底 / 失败兜底
// 4. manager 缺省回退模块单例（未初始化抛错）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubagentManager } from './subagent-manager';
import { TeamService } from './team-service';

const mocks = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockLogger };
});

vi.mock('../../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

/** 创建 fake SubagentManager（run 可控；mock 方法类型显式化） */
function createFakeManager(): { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn() };
}

function makeService(manager: { run: ReturnType<typeof vi.fn> }): TeamService {
  return new TeamService(manager as unknown as SubagentManager);
}

describe('TeamService 批次6 缺口补全', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('全部成员成功：结果汇总 + succeeded/failed 计数', async () => {
    const manager = createFakeManager();
    manager.run.mockResolvedValue({ output: '结论 A', durationMs: 100, hasOutput: true });
    const service = makeService(manager);

    const result = await service.runTeam(
      [
        { agent: 'general', task: '任务 1' },
        { agent: 'code_review', task: '任务 2' },
      ],
      '/tmp/proj',
    );

    expect(manager.run).toHaveBeenCalledTimes(2);
    expect(manager.run).toHaveBeenCalledWith('general', '任务 1', '/tmp/proj');
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.leaderSummary).toBeNull();
    expect(result.members[0]).toMatchObject({
      agent: 'general',
      task: '任务 1',
      success: true,
      output: '结论 A',
    });
  });

  it('成员失败隔离：单成员 reject 不阻断其他成员', async () => {
    const manager = createFakeManager();
    manager.run
      .mockRejectedValueOnce(new Error('provider down'))
      .mockResolvedValueOnce({ output: '结论 B', durationMs: 50, hasOutput: true });
    const service = makeService(manager);

    const result = await service.runTeam(
      [
        { agent: 'general', task: '任务 1' },
        { agent: 'plan', task: '任务 2' },
      ],
      '/tmp/proj',
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    const failed = result.members.find((m) => !m.success);
    expect(failed?.output).toContain('provider down');
    expect(mocks.mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'general', error: expect.any(Error) }),
      '团队成员执行失败',
    );
    // 第二个成员仍执行
    expect(manager.run).toHaveBeenCalledTimes(2);
  });

  it('leader 汇总：默认 general 聚合成员结果', async () => {
    const manager = createFakeManager();
    manager.run.mockResolvedValue({ output: '成员结论', durationMs: 100, hasOutput: true });
    const service = makeService(manager);

    const result = await service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj', {});

    expect(result.leaderSummary).toBe('成员结论');
    // 领导调用：agent 默认 general + 任务含序列化成员结果
    const leaderCall = manager.run.mock.calls[1];
    expect(leaderCall?.[0]).toBe('general');
    expect(String(leaderCall?.[1])).toContain('团队成员的执行结果');
    expect(String(leaderCall?.[1])).toContain('【general】成功');
  });

  it('leader 自定义 agent：按配置委派领导子代理', async () => {
    const manager = createFakeManager();
    manager.run.mockResolvedValue({ output: '汇总', durationMs: 50, hasOutput: true });
    const service = makeService(manager);

    await service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj', { agent: 'plan' });

    expect(manager.run.mock.calls[1]?.[0]).toBe('plan');
  });

  it('leader 无文本输出：返回兜底说明', async () => {
    const manager = createFakeManager();
    manager.run
      .mockResolvedValueOnce({ output: '成员', durationMs: 10, hasOutput: true })
      .mockResolvedValueOnce({ output: '', durationMs: 20, hasOutput: false });
    const service = makeService(manager);

    const result = await service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj', {});

    expect(result.leaderSummary).toBe('领导汇总完成但无文本输出。');
  });

  it('leader 失败：返回错误说明，不阻断成员结果', async () => {
    const manager = createFakeManager();
    manager.run
      .mockResolvedValueOnce({ output: '成员', durationMs: 10, hasOutput: true })
      .mockRejectedValueOnce(new Error('leader crashed'));
    const service = makeService(manager);

    const result = await service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj', {});

    expect(result.leaderSummary).toContain('领导汇总失败');
    expect(result.leaderSummary).toContain('leader crashed');
    expect(result.members).toHaveLength(1);
    expect(result.members[0]?.success).toBe(true);
  });

  it('成员输出截断：leader 输入序列化限制 1500 字符', async () => {
    const manager = createFakeManager();
    manager.run.mockResolvedValue({
      output: 'x'.repeat(2000),
      durationMs: 10,
      hasOutput: true,
    });
    const service = makeService(manager);

    await service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj', {});

    const leaderTask = String(manager.run.mock.calls[1]?.[1]);
    // 序列化内容截断到 1500 字符
    expect(leaderTask).toContain('x'.repeat(1500));
    expect(leaderTask).not.toContain('x'.repeat(1501));
  });

  it('成员抛非 Error 值：String() 兜底输出', async () => {
    const manager = createFakeManager();
    manager.run.mockRejectedValueOnce('boom-string');
    const service = makeService(manager);

    const result = await service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj');

    expect(result.members[0]?.success).toBe(false);
    expect(result.members[0]?.output).toContain('boom-string');
  });

  it('manager 未注入且模块单例未初始化：runTeam 抛错', async () => {
    const service = new TeamService();
    // 本文件未调用 initSubagentManager，模块单例为 null
    await expect(
      service.runTeam([{ agent: 'general', task: '任务' }], '/tmp/proj'),
    ).rejects.toThrow(/SubagentManager 未初始化/);
  });
});
