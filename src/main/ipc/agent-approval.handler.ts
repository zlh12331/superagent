import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/tools/permission-service';
import type { IpcHandlerContext } from '../utils/wrap';

export interface AgentApprovalHandlerDeps {
  readonly permissionService: IPermissionService;
}

type AgentApprovalHandlers = Pick<
  InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['agent'],
  'approvalResponse'
>;

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
