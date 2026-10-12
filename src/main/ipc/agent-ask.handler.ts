// agent-ask.handler.ts：渲染层对 agentAsk 问题（选择题/审批问答）的应答回传
import type { AskRespondReq, AskRespondRes } from '@code-agent/shared/main';
import type { AgentAskService } from '../infra/ai/agent/agent-ask-service';
import type { IpcHandlerContext } from '../utils/wrap';

/** 依赖注入工厂：askService 是模块级单例（不经服务容器），index.ts 直传 */
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
