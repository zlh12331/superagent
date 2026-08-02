// src/main/ipc/agent.handler.ts
// Agent 域 IPC handler（AgentService 暴露给渲染层的入口）
//
// 注册 2 个请求-响应 channel：
// - agent:run  发起一次 agent 对话，返回 sessionId（自动多轮工具调用直到完成）
// - agent:stop 中断指定 sessionId 的 agent 对话
//
// 流式事件由 AgentService 主动推送（不在此 handler 返回）：
// - agent:stream:part    逐 part 推送 UIMessageStreamPart（text/tool-call/tool-result/finish）
// - agent:stream:end     agent 对话结束（含原因：completed/aborted/error）
// - agent:stream:error   agent 对话异常结束（含 code + message）
// - agent:tool:call      工具调用事件（由 ToolExecutor 推送，含入参与权限级别）
// - agent:tool:result    工具执行结果事件（由 ToolExecutor 推送，含 output 或 error）
// - agent:approval:request 审批请求事件（由 ToolExecutor 推送，permission='ask' 时）
//
// 设计要点：
// - 与 chat.handler.ts / tool.handler.ts 一致的 DI 模式
// - 入参 zod schema 来自 @code-agent/shared（AgentRunReqSchema / AgentStopReqSchema）
// - agent:run 立即返回 sessionId，后续流式事件通过 webContents.send 推送
// - agent:stop 触发 AbortController.abort()，流推送协程会捕获 AbortError 并推送 reason='aborted' 的 END
//
// 与 agent-approval.handler.ts 的关系：
// - agent-approval.handler.ts 单独注册 agent:approval:response（审批回传通道）
// - 本 handler 注册 agent:run / agent:stop（agent 对话生命周期）
// - 拆分到独立文件便于关注点分离：审批响应是工具系统的一部分（依赖 PermissionService），
//   agent 对话生命周期是 AgentService 的职责

import {
  type AgentRunReq,
  AgentRunReqSchema,
  type AgentRunRes,
  type AgentStopReq,
  AgentStopReqSchema,
  type AgentStopRes,
  IPC_CHANNELS,
} from '@code-agent/shared';
import type { IAgentService } from '../infra/ai/agent-service';
import { wrap } from '../utils/wrap';

/**
 * Agent 域 handler 依赖
 *
 * 通过依赖注入解耦 handler 与具体 AgentService 实现：
 * - 生产环境：ServiceContainer 注入默认 AgentService 实例
 * - 测试环境：可注入 mock 实现，不依赖真实 streamText / 工具系统
 */
export interface AgentHandlerDeps {
  /** AgentService 实例（由 ServiceContainer 注入） */
  readonly agentService: IAgentService;
}

/**
 * 注册 Agent 域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与 registerChatHandlers / registerToolHandlers 并列。
 *
 * @param deps 依赖项：包含 IAgentService 实例（由 ServiceContainer 注入）
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerAgentHandlers(deps: AgentHandlerDeps): void {
  const { agentService } = deps;

  // 发起 agent 对话：启动 streamText 流（带 tools + stopWhen），立即返回 sessionId
  // 后续流式事件通过 AGENT_STREAM_PART / AGENT_TOOL_CALL / AGENT_TOOL_RESULT / AGENT_APPROVAL_REQUEST 推送
  // 渲染层用返回的 sessionId 订阅后续事件并支持中断
  wrap<AgentRunReq, AgentRunRes>(IPC_CHANNELS.AGENT_RUN, AgentRunReqSchema, async (input, ctx) => {
    const sessionId = await agentService.startAgent({
      messages: input.messages,
      sessionId: input.sessionId,
      workingDir: input.workingDir,
      systemPrompt: input.systemPrompt,
      maxSteps: input.maxSteps,
      mode: input.mode,
      webContents: ctx.sender,
    });
    return { sessionId };
  });

  // 中断 agent 对话：触发 AbortController.abort()
  // 流推送协程会捕获 AbortError 并推送 reason='aborted' 的 AGENT_STREAM_END
  // 正在执行的工具会被 ToolExecutor 检测 abortSignal 后中止（返回 TOOL_ABORTED 错误）
  wrap<AgentStopReq, AgentStopRes>(IPC_CHANNELS.AGENT_STOP, AgentStopReqSchema, async (input) => {
    const stopped = agentService.abort(input.sessionId);
    return { stopped };
  });
}
