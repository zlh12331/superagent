import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/tools/permission-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * Agent 审批响应 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 PermissionService 实现：
 * - 生产环境：ServiceContainer 注入默认 PermissionService 实例
 * - 测试环境：可注入 mock 实现，不依赖真实 pending Map
 */
export interface AgentApprovalHandlerDeps {
  /** PermissionService 实例（由 ServiceContainer 注入） */
  readonly permissionService: IPermissionService;
}

/** agent 域审批子集（与 agent.handler 的 run/stop 合并成完整 agent 域） */
type AgentApprovalHandlers = Pick<
  InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['agent'],
  'approvalResponse'
>;

/**
 * 创建 Agent 审批响应 handler 实现
 *
 * @param deps 依赖项：包含 IPermissionService 实例
 */
export function createAgentApprovalHandlers(deps: AgentApprovalHandlerDeps): AgentApprovalHandlers {
  const { permissionService } = deps;

  return {
    approvalResponse: async (input) => {
      permissionService.handleApprovalResponse(
        input.approvalId,
        input.approved,
        input.rememberDecision,
      );
      return { ok: true };
    },
  };
}
