// src/main/ipc/agent-ask.handler.ts
// Agent 提问响应 IPC handler（AgentAskService 回传通道，定义表驱动）
//
// 实现 1 个请求-响应方法：
// - respondAsk  渲染层回传用户对提问的回答（ask_user_question 工具闭环）
//
// 设计要点：
// - DI 模式：通过 deps 注入 AgentAskService 实例
// - 语义是"回传事件"：
//     主进程 webContents.send('agent:event:ask') 推送提问
//     渲染层弹出提问对话框，用户操作后 invoke('agent:ask:respond', req) 回传
//     主进程收到后调用 AgentAskService.respond resolve 对应 pending
// - 返回 { ok: true } 仅作为 invoke 的 ack，业务结果经 agent:tool:result 推送
// ──────────────────────────────────────────────────────────────

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
