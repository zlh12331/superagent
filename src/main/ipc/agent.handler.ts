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

function assertUserInputWithinCap(messages: unknown): string {
  const lastUser = extractLastUserText(messages);
  if (lastUser.length > MAX_USER_INPUT_HARD_CAP) {
    throw new AppError(ErrorCode.INVALID_INPUT, `消息过长，上限 ${MAX_USER_INPUT_HARD_CAP} 字符`);
  }
  return lastUser;
}

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
