// agent.handler.ts：agent 域生命周期 IPC——run（启动回合，含记忆召回拼接）与 stop（中断）
// 记忆依赖可选注入：memoryWire 记录末条用户输入、memoryPort+promptService 召回记忆拼进系统提示词
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

/** 依赖注入工厂：memory 三件套可选（记忆关闭/未配置时全部缺省，主流程不受影响） */
export interface AgentHandlerDeps {
  readonly agentService: IAgentService;
  readonly memoryWire?: MemoryCaptureWire;
  readonly memoryPort?: MemoryPort;
  readonly promptService?: IPromptService;
}

type AgentLifecycleHandlers = Pick<
  InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['agent'],
  'run' | 'stop'
>;

// 硬上限在 IPC 层拦截（比模型上下文窗口早得多）：防超大粘贴直接打爆后续 token 估算与压缩链
function assertUserInputWithinCap(messages: unknown): string {
  const lastUser = extractLastUserText(messages);
  if (lastUser.length > MAX_USER_INPUT_HARD_CAP) {
    throw new AppError(ErrorCode.INVALID_INPUT, `消息过长，上限 ${MAX_USER_INPUT_HARD_CAP} 字符`);
  }
  return lastUser;
}

/**
 * 系统提示词组装：显式指定 systemPrompt 时原样用；否则（记忆开启 + 有末条用户输入 + 有会话键）
 * 并行取「基础提示词」与「记忆召回」，命中则把记忆包进 <memory_context> 追加
 *
 * 任何一步失败静默回落无记忆提示词——记忆是增强，不能阻塞回合启动
 */
async function resolvePromptWithMemoryRecall(params: {
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

/** 依赖注入工厂 */
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
      // 记录末条用户输入：记忆捕获 wire 靠它决定记什么（回合结束后异步蒸馏）
      if (lastUser.trim().length > 0) {
        memoryWire?.noteLastUser(sessionId, lastUser);
      }
      // 先推 streamStart 事件，渲染层凭 sessionId 建立流订阅
      emitEvent(ctx.sender, IPC_DEFINITIONS.agent.subscribeStreamStart, { sessionId });
      return { sessionId };
    },

    stop: async (input) => {
      const stopped = agentService.abort(input.sessionId);
      return { stopped };
    },
  };
}
