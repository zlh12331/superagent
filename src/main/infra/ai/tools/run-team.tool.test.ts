// src/main/infra/ai/tools/run-team.tool.test.ts
// run_team 工具单测：并行委派 + 汇总格式化 + 异常降级（mock teamService 单例）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunTeamTool } from './run-team.tool';
import type { ToolContext } from './tool';

vi.mock('../agent/team-service', () => ({
  teamService: { runTeam: vi.fn() },
}));

import { teamService } from '../agent/team-service';

const mockedRunTeam = vi.mocked(teamService.runTeam);
const ctx = { workingDir: '/repo' } as unknown as ToolContext;

describe('run_team', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功：汇总统计 + 成员行 + 领导汇总', async () => {
    mockedRunTeam.mockResolvedValueOnce({
      succeeded: 2,
      failed: 0,
      members: [
        { agent: 'general', task: '读代码', success: true, durationMs: 1_500, output: '结论 A' },
        { agent: 'plan', task: '设计', success: true, durationMs: 500, output: '结论 B' },
      ],
      leaderSummary: '领导结论',
    });
    const res = await createRunTeamTool().execute(
      {
        members: [
          { agent: 'general', task: '读代码' },
          { agent: 'plan', task: '设计' },
        ],
        leader: undefined,
      },
      ctx,
    );
    expect(teamService.runTeam).toHaveBeenCalledWith(
      [
        { agent: 'general', task: '读代码' },
        { agent: 'plan', task: '设计' },
      ],
      '/repo',
      undefined,
    );
    expect(res.output).toContain('成功 2 / 失败 0');
    expect(res.output).toContain('✅');
    expect(res.output).toContain('结论 A');
    expect(res.output).toContain('【领导汇总】');
  });

  it('leader.agent 传入时透传（条件展开）', async () => {
    mockedRunTeam.mockResolvedValueOnce({
      succeeded: 1,
      failed: 0,
      members: [{ agent: 'general', task: 't', success: true, durationMs: 100, output: 'o' }],
      leaderSummary: null,
    });
    await createRunTeamTool().execute(
      { members: [{ agent: 'general', task: 't' }], leader: { agent: 'code_review' } },
      ctx,
    );
    expect(teamService.runTeam).toHaveBeenCalledWith([{ agent: 'general', task: 't' }], '/repo', {
      agent: 'code_review',
    });
  });

  it('运行失败 → 团队执行失败提示，不抛异常', async () => {
    mockedRunTeam.mockRejectedValueOnce(new Error('provider down'));
    const res = await createRunTeamTool().execute(
      { members: [{ agent: 'general', task: 't' }], leader: undefined },
      ctx,
    );
    expect(res.title).toBe('团队执行失败');
    expect(res.output).toContain('provider down');
  });
});
