// src/main/infra/ai/tools/run-subagent.tool.test.ts
// run_subagent 工具单测：委派 + 有无文本输出分支 + 异常降级（mock SubagentManager 单例）

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRunSubagentTool } from './run-subagent.tool';
import type { ToolContext } from './tool';

const { mockManager } = vi.hoisted(() => ({ mockManager: { run: vi.fn() } }));

vi.mock('../agent/subagent-manager', () => ({
  getSubagentManager: () => mockManager,
}));

const mockedRun = vi.mocked(mockManager.run);
const ctx = { workingDir: '/repo' } as unknown as ToolContext;

describe('run_subagent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('委派成功 + hasOutput → 输出结果（含耗时）', async () => {
    mockedRun.mockResolvedValueOnce({ hasOutput: true, output: '审查结论', durationMs: 2_000 });
    const res = await createRunSubagentTool().execute(
      { agent: 'code_review', task: '审查登录' },
      ctx,
    );
    expect(mockManager.run).toHaveBeenCalledWith('code_review', '审查登录', '/repo');
    expect(res.output).toContain('【子代理 code_review 结果】');
    expect(res.output).toContain('2s');
    expect(res.output).toContain('审查结论');
  });

  it('委派成功但无文本输出 → 提示检查工作区（纯工具回合）', async () => {
    mockedRun.mockResolvedValueOnce({ hasOutput: false, output: '', durationMs: 300 });
    const res = await createRunSubagentTool().execute({ agent: 'plan', task: '读代码' }, ctx);
    expect(res.title).toBe('子代理完成: plan');
    expect(res.output).toContain('无文本输出');
  });

  it('子代理失败 → 异常降级为错误输出', async () => {
    mockedRun.mockRejectedValueOnce(new Error('子代理超时'));
    const res = await createRunSubagentTool().execute({ agent: 'general', task: 'x' }, ctx);
    expect(res.title).toBe('子代理失败: general');
    expect(res.output).toContain('子代理超时');
  });
});
