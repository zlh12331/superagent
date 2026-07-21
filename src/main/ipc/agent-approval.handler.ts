// src/main/ipc/agent-approval.handler.ts
// Agent 域审批响应 IPC handler（PermissionService 暴露给渲染层的回传通道）
//
// 注册 1 个请求-响应 channel：
// - agent:approval:response  渲染层回传用户审批结果（approve / deny / remember）
//
// 设计要点：
// - 与其他 handler 一致的 DI 模式：通过 ServiceContainer 注入 IPermissionService 实例
// - 入参 zod schema 来自 @novel-writer/shared（AgentApprovalResponseReqSchema）
// - 此 channel 是请求-响应模式，但语义是"回传事件"：
//     主进程通过 webContents.send('agent:approval:request') 推送审批请求
//     渲染层弹出 ApprovalModal，用户操作后通过 invoke('agent:approval:response', req) 回传
//     主进程收到后调用 PermissionService.handleApprovalResponse resolve 对应 Promise
// - 返回 { ok: true } 仅作为 invoke 的 ack，业务结果通过后续 agent:tool:result 推送
//
// 与 agent.handler.ts 的关系：
// - agent.handler.ts（P4 实现）注册 agent:run / agent:stop
// - 本 handler 单独注册 agent:approval:response，因为审批响应是工具系统的一部分，
//   依赖 PermissionService 而非 AgentService
// - 拆分到独立文件便于关注点分离，避免 agent.handler.ts 在 P4 之前被创建

import {
  type AgentApprovalResponseReq,
  AgentApprovalResponseReqSchema,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import type { IPermissionService } from '../infra/agent/permission-service';
import { wrap } from '../utils/wrap';

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

/**
 * 注册 Agent 审批响应 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerToolHandlers 并列。
 *
 * @param deps 依赖项：包含 IPermissionService 实例
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerAgentApprovalHandlers(deps: AgentApprovalHandlerDeps): void {
  const { permissionService } = deps;

  // 审批响应回传：渲染层 ApprovalModal 用户操作后调用
  // 调用 PermissionService.handleApprovalResponse resolve 对应 approvalId 的 Promise
  // ToolExecutor 等待的 Promise 解除阻塞，继续执行或返回 TOOL_PERMISSION_DENIED
  // 返回 { ok: true } 仅作为 invoke 的 ack，业务结果通过 agent:tool:result 推送
  wrap<AgentApprovalResponseReq, { ok: boolean }>(
    IPC_CHANNELS.AGENT_APPROVAL_RESPONSE,
    AgentApprovalResponseReqSchema,
    async (input) => {
      permissionService.handleApprovalResponse(
        input.approvalId,
        input.approved,
        input.rememberDecision,
      );
      return { ok: true };
    },
  );
}
