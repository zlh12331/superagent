// src/main/ipc/agent-approval.handler.ts
// Agent 域审批响应 IPC handler（PermissionService 暴露给渲染层的回传通道，定义表驱动）
//
// 实现 1 个请求-响应方法：
// - approvalResponse  渲染层回传用户审批结果（approve / deny / remember）
//
// 设计要点：
// - DI 模式：通过 deps 注入 IPermissionService 实例
// - 此 channel 是请求-响应模式，但语义是"回传事件"：
//     主进程通过 webContents.send('agent:approval:request') 推送审批请求
//     渲染层弹出 ApprovalModal，用户操作后通过 invoke('agent:approval:response', req) 回传
//     主进程收到后调用 PermissionService.handleApprovalResponse resolve 对应 Promise
// - 返回 { ok: true } 仅作为 invoke 的 ack，业务结果通过后续 agent:tool:result 推送
//
// 与 agent.handler.ts 的关系：
// - agent.handler.ts 实现 agent:run / agent:stop
// - 本 handler 单独实现 agent:approval:response，因为审批响应是工具系统的一部分，
//   依赖 PermissionService 而非 AgentService

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IPermissionService } from '../infra/ai/permission-service';
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
    // 审批响应回传：渲染层 ApprovalModal 用户操作后调用
    // 调用 PermissionService.handleApprovalResponse resolve 对应 approvalId 的 Promise
    // ToolExecutor 等待的 Promise 解除阻塞，继续执行或返回 TOOL_PERMISSION_DENIED
    // 返回 { ok: true } 仅作为 invoke 的 ack，业务结果通过 agent:tool:result 推送
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
