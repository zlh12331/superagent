import type { AskRespondReq, AskRespondRes } from '@code-agent/shared/main';
import type { AgentAskService } from '../infra/ai/agent/agent-ask-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** Agent 提问域 handler 工厂 */
export function createAgentAskHandlers({ askService }: { readonly askService: AgentAskService }): {
  readonly respondAsk: (req: AskRespondReq, ctx: IpcHandlerContext) => Promise<AskRespondRes>;
} {
  return {
    /** 渲染层回传用户回答（resolve 对应 pending） */
    respondAsk: async (req: AskRespondReq): Promise<AskRespondRes> => {
      const matched = askService.respond(req.askId, req.answers);
      return { ok: matched };
    },
  };
}
