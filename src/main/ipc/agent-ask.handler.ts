import type { AskRespondReq, AskRespondRes } from '@code-agent/shared/main';
import type { AgentAskService } from '../infra/ai/agent/agent-ask-service';
import type { IpcHandlerContext } from '../utils/wrap';

export function createAgentAskHandlers({ askService }: { readonly askService: AgentAskService }): {
  readonly respondAsk: (req: AskRespondReq, ctx: IpcHandlerContext) => Promise<AskRespondRes>;
} {
  return {
    respondAsk: async (req: AskRespondReq): Promise<AskRespondRes> => {
      const matched = askService.respond(req.askId, req.answers);
      return { ok: matched };
    },
  };
}
