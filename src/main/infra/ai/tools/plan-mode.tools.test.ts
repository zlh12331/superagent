// src/main/infra/ai/tools/plan-mode.tools.test.ts
// 计划模式切换工具单测：previousMode 状态恢复 / 幂等 / 模式持久化

import type { ApprovalMode } from '@code-agent/shared/main';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPermissionService } from './permission-service';
import { createEnterPlanModeTool, createExitPlanModeTool } from './plan-mode.tools';

vi.mock('../../storage/approval-pref', () => ({
  writeApprovalMode: vi.fn(async () => undefined),
}));

function createPermissionService(initialMode: ApprovalMode = 'ask') {
  let current: ApprovalMode = initialMode;
  return {
    getApprovalMode: vi.fn(() => current),
    setApprovalMode: vi.fn((mode: ApprovalMode) => {
      current = mode;
    }),
  } as unknown as IPermissionService;
}

describe('plan_mode 工具（enter/exit 配对）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('进入 plan → 记录前模式并切换；退出 → 恢复前模式', async () => {
    const permission = createPermissionService('auto');
    const enter = createEnterPlanModeTool(permission);
    const exit = createExitPlanModeTool(permission);

    const enterRes = await enter.execute({ reason: '先分析' }, {} as never);
    expect(enterRes.title).toBe('已进入计划模式');
    expect(permission.getApprovalMode()).toBe('plan');

    const exitRes = await exit.execute({}, {} as never);
    expect(exitRes.title).toBe('已退出计划模式');
    expect(permission.getApprovalMode()).toBe('auto');
  });

  it('已在 plan 再 enter → 幂等提示，不重复写入', async () => {
    const permission = createPermissionService('plan');
    const enter = createEnterPlanModeTool(permission);
    const res = await enter.execute({}, {} as never);
    expect(res.title).toBe('已在计划模式');
    expect(permission.setApprovalMode).not.toHaveBeenCalled();
  });

  it('不在 plan 时 exit → 明确提示', async () => {
    const permission = createPermissionService('ask');
    const exit = createExitPlanModeTool(permission);
    const res = await exit.execute({}, {} as never);
    expect(res.title).toBe('不在计划模式');
  });
});
