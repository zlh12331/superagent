// agent-approval.handler.ts：审批应答 IPC——渲染层对权限审批弹窗的批准/拒绝/记住决定
// 独立文件而非并入 agent.handler：审批链与回合链是两条契约面（37 号拆分惯例）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/tools/permission-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：index.ts 传入 permissionService */
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
