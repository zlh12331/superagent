// src/main/ipc/agent.handler.ts
// Agent 域 IPC handler（AgentService 暴露给渲染层的入口，定义表驱动）
//
// 实现 2 个请求-响应方法：
// - run  发起一次 agent 对话，返回 sessionId（自动多轮工具调用直到完成）
// - stop 中断指定 sessionId 的 agent 对话
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
// - DI 模式：通过 deps 注入 IAgentService 实例
// - agent:run 立即返回 sessionId，后续流式事件通过 webContents.send 推送
// - agent:stop 触发 AbortController.abort()，流推送协程会捕获 AbortError 并推送 reason='aborted' 的 END
//
// 与 agent-approval.handler.ts 的关系：
// - agent-approval.handler.ts 单独实现 agent:approval:response（审批回传通道）
// - 本 handler 实现 agent:run / agent:stop（agent 对话生命周期）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { IAgentService } from '../infra/ai/agent/agent-service';
import type { IPromptService } from '../infra/ai/prompt/prompt-service';
import type { MemoryCaptureWire } from '../infra/memory-hub/capture-wire';
import { extractLastUserText } from '../infra/memory-hub/capture-wire';
import type { MemoryPort } from '../infra/memory-hub/types';
import type { IpcHandlerContext } from '../utils/wrap';

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
  /** 记忆捕获接线（可选：注入后每轮对话自动写入 MemoryHub L0） */
  readonly memoryWire?: MemoryCaptureWire;
  /** 记忆引擎端口（可选：用于 run 前预取召回注入） */
  readonly memoryPort?: MemoryPort;
  /** Prompt 服务（可选：召回注入时解析基础系统提示词） */
  readonly promptService?: IPromptService;
}

/** agent 域对话生命周期子集（与 agent-approval.handler 的 approvalResponse 合并成完整 agent 域） */
type AgentLifecycleHandlers = Pick<
  InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['agent'],
  'run' | 'stop'
>;

/**
 * 创建 Agent 域 handler 实现
 *
 * @param deps 依赖项：包含 IAgentService 实例（由 ServiceContainer 注入）
 */
export function createAgentHandlers(deps: AgentHandlerDeps): AgentLifecycleHandlers {
  const { agentService, memoryWire, memoryPort, promptService } = deps;

  return {
    // 发起 agent 对话：启动 streamText 流（带 tools + stopWhen），立即返回 sessionId
    // 后续流式事件通过 AGENT_STREAM_PART / AGENT_TOOL_CALL / AGENT_TOOL_RESULT / AGENT_APPROVAL_REQUEST 推送
    // 渲染层用返回的 sessionId 订阅后续事件并支持中断
    run: async (input, ctx) => {
      const lastUser = extractLastUserText(input.messages);
      // 记忆预取召回：仅在渲染层未显式指定 systemPrompt 时注入一次性上下文块
      let systemPrompt = input.systemPrompt;
      if (
        systemPrompt === undefined &&
        memoryPort !== undefined &&
        promptService !== undefined &&
        lastUser.length > 0
      ) {
        try {
          const [base, mem] = await Promise.all([
            promptService.resolvePrompt(undefined, input.workingDir),
            memoryPort.recall({ query: lastUser }),
          ]);
          if (mem.ok && mem.context.trim().length > 0) {
            systemPrompt = `${base}\n\n<memory_context>\n${mem.context.trim()}\n</memory_context>`;
          }
        } catch {
          // 召回失败不阻断对话（sidecar 冷启动/未配置等场景静默降级）
        }
      }
      const sessionId = await agentService.startAgent({
        messages: input.messages,
        sessionId: input.sessionId,
        workingDir: input.workingDir,
        systemPrompt,
        maxSteps: input.maxSteps,
        mode: input.mode,
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        webContents: ctx.sender,
      });
      // P2 修复：用最终 sessionId 注入本轮用户输入。此前用 `input.sessionId ?? ''`，
      // 首次对话时 input.sessionId 为 undefined → key='' 与 turn event 的
      // 真实 sessionId（startAgent 生成的 UUID）不匹配 → TURN_END 捕获时
      // user_content 为空 → 上游 /capture 400 → 自动捕获永不生效。
      if (lastUser.trim().length > 0) {
        memoryWire?.noteLastUser(sessionId, lastUser);
      }
      return { sessionId };
    },

    // 中断 agent 对话：触发 AbortController.abort()
    // 流推送协程会捕获 AbortError 并推送 reason='aborted' 的 AGENT_STREAM_END
    // 正在执行的工具会被 ToolExecutor 检测 abortSignal 后中止（返回 TOOL_ABORTED 错误）
    stop: async (input) => {
      const stopped = agentService.abort(input.sessionId);
      return { stopped };
    },
  };
}
