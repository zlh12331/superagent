import {
  AppError,
  ErrorCode,
  type InferHandlers,
  IPC_DEFINITIONS,
  MAX_USER_INPUT_HARD_CAP,
} from '@code-agent/shared/main';

import type { IAgentService } from '../infra/ai/agent/agent-service';
import type { IPromptService, ResolvedPrompt } from '../infra/ai/prompt/prompt-service';
import type { MemoryCaptureWire } from '../infra/memory-hub/capture-wire';
import { extractLastUserText } from '../infra/memory-hub/capture-wire';
import { isMemoryEnabled } from '../infra/memory-hub/memory-pref';
import type { MemoryPort } from '../infra/memory-hub/types';
import { emitEvent } from '../utils/emit-event';
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
 * 主进程纵深防御：提取最后一条用户消息，超出硬上限即拒绝
 *
 * 渲染层已拦截 base ≤ MAX_MESSAGE_LENGTH_CHARS（8000）并允许附件追加文本；
 * 本函数仅拦截绕过渲染层的病态超大输入（正常 UI 消息含附件也不会触达硬上限）。
 *
 * @returns 最后一条用户文本（供 handler 用于记忆捕获）
 */
function assertUserInputWithinCap(messages: unknown): string {
  const lastUser = extractLastUserText(messages);
  if (lastUser.length > MAX_USER_INPUT_HARD_CAP) {
    throw new AppError(ErrorCode.INVALID_INPUT, `消息过长，上限 ${MAX_USER_INPUT_HARD_CAP} 字符`);
  }
  return lastUser;
}

/**
 * 记忆预取召回 + 基础 prompt 解析（独立函数便于 run 保持认知复杂度）
 *
 * 召回前置条件（任一不满足则原样返回，不做任何解析）：
 * 渲染层未显式指定 systemPrompt、记忆端口/prompt 服务可用、有用户文本、
 * 会话 key 非空（上游 RecallRequest 要求非空，缺失/空串 → HTTP 400——
 * 新会话跳过召回，首次对话也无历史可召回）、用户开启记忆功能。
 *
 * P2-32：基础 prompt 只解析一次——召回命中时拼接 <memory_context>，
 * 未命中时经 resolvedBase 复用给 startAgent（同回合免二次 resolvePrompt：
 * 重复读库 + git status 子进程 + AGENTS.md 遍历）。
 */
async function resolvePromptWithMemoryRecall(params: {
  /** 渲染层显式指定的 systemPrompt（可能为 undefined） */
  readonly baseSystemPrompt: string | undefined;
  readonly lastUser: string;
  readonly workingDir: string;
  readonly recallSessionKey: string | undefined;
  readonly memoryPort: MemoryPort | undefined;
  readonly promptService: IPromptService | undefined;
}): Promise<{
  readonly systemPrompt: string | undefined;
  readonly resolvedBase: ResolvedPrompt | undefined;
}> {
  const { baseSystemPrompt, lastUser, workingDir, recallSessionKey, memoryPort, promptService } =
    params;
  if (
    baseSystemPrompt !== undefined ||
    memoryPort === undefined ||
    promptService === undefined ||
    lastUser.length === 0 ||
    recallSessionKey === undefined ||
    recallSessionKey.length === 0 ||
    !isMemoryEnabled()
  ) {
    return { systemPrompt: baseSystemPrompt, resolvedBase: undefined };
  }
  try {
    const [base, mem] = await Promise.all([
      promptService.resolvePrompt(undefined, workingDir),
      memoryPort.recall({ query: lastUser, sessionKey: recallSessionKey }),
    ]);
    if (mem.ok && mem.context.trim().length > 0) {
      return {
        systemPrompt: `${base.content}\n\n<memory_context>\n${mem.context.trim()}\n</memory_context>`,
        resolvedBase: base,
      };
    }
    return { systemPrompt: baseSystemPrompt, resolvedBase: base };
  } catch {
    return { systemPrompt: baseSystemPrompt, resolvedBase: undefined };
  }
}

/**
 * 创建 Agent 域 handler 实现
 *
 * @param deps 依赖项：包含 IAgentService 实例（由 ServiceContainer 注入）
 */
export function createAgentHandlers(deps: AgentHandlerDeps): AgentLifecycleHandlers {
  const { agentService, memoryWire, memoryPort, promptService } = deps;

  return {
    run: async (input, ctx) => {
      const lastUser = assertUserInputWithinCap(input.messages);
      const { systemPrompt, resolvedBase } = await resolvePromptWithMemoryRecall({
        baseSystemPrompt: input.systemPrompt,
        lastUser,
        workingDir: input.workingDir,
        recallSessionKey: input.sessionId,
        memoryPort,
        promptService,
      });
      const sessionId = await agentService.startAgent({
        messages: input.messages,
        sessionId: input.sessionId,
        workingDir: input.workingDir,
        systemPrompt,
        ...(resolvedBase !== undefined ? { resolvedPrompt: resolvedBase } : {}),
        maxSteps: input.maxSteps,
        mode: input.mode,
        ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        webContents: ctx.sender,
      });
      if (lastUser.trim().length > 0) {
        memoryWire?.noteLastUser(sessionId, lastUser);
      }
      emitEvent(ctx.sender, IPC_DEFINITIONS.agent.subscribeStreamStart, { sessionId });
      return { sessionId };
    },

    stop: async (input) => {
      const stopped = agentService.abort(input.sessionId);
      return { stopped };
    },
  };
}
