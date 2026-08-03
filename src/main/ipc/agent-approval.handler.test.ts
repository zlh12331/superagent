// src/main/ipc/agent-approval.handler.test.ts
// agent-approval.handler 单测：approvalResponse 回传（fake PermissionService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type AgentApprovalHandlerDeps,
  createAgentApprovalHandlers,
} from './agent-approval.handler';

/** 创建 fake PermissionService */
function createFakePermissionService() {
  return {
    handleApprovalResponse: vi.fn(),
    decide: vi.fn(),
    requestApproval: vi.fn(),
    rememberDecision: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentApprovalHandlerDeps['permissionService'];
}

describe('agent-approval.handler', () => {
  let permissionService: ReturnType<typeof createFakePermissionService>;

  beforeEach(() => {
    vi.clearAllMocks();
    permissionService = createFakePermissionService();
  });

  it('approvalResponse：转发审批结果并返回 ok', async () => {
    const handlers = createAgentApprovalHandlers({ permissionService });
    const result = await handlers.approvalResponse(
      { approvalId: 'ap-1', approved: true, rememberDecision: false },
      {} as never,
    );
    expect(permissionService.handleApprovalResponse).toHaveBeenCalledWith('ap-1', true, false);
    expect(result).toEqual({ ok: true });
  });

  it('approvalResponse（拒绝 + 记忆）：透传三个参数', async () => {
    const handlers = createAgentApprovalHandlers({ permissionService });
    await handlers.approvalResponse(
      { approvalId: 'ap-2', approved: false, rememberDecision: true },
      {} as never,
    );
    expect(permissionService.handleApprovalResponse).toHaveBeenCalledWith('ap-2', false, true);
  });
});
