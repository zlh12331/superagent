// src/main/ipc/session.handler.ts
// Session 域 IPC handler：注册会话持久化查询通道
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注册 4 个 session:* 请求-响应 channel
// - 入参用 zod schema 校验，出参类型由 Res 接口保证
// - 把 IPC 调用委托给 SessionService
//
// 设计：
// - 与 GitHandler / CodebaseHandler 一致的 DI 模式
// - SessionHandlerDeps 接口声明依赖，便于测试 mock
// - 不持有状态，所有调用转发给 SessionService
//
// 注意：
// - SessionService 的 create / appendMessage 是内部 API（非 IPC 通道）
//   由 AgentService / ChatService 直接调用，不在此 handler 中注册
// - 仅暴露 list / get / delete / rename 4 个只读 + 元数据操作通道
// ──────────────────────────────────────────────────────────────

import {
  IPC_CHANNELS,
  type SessionDeleteReq,
  SessionDeleteReqSchema,
  type SessionDeleteRes,
  type SessionGetReq,
  SessionGetReqSchema,
  type SessionGetRes,
  type SessionListReq,
  SessionListReqSchema,
  type SessionListRes,
  type SessionRenameReq,
  SessionRenameReqSchema,
  type SessionRenameRes,
} from '@novel-writer/shared';
import type { ISessionService } from '../infra/storage/session-service';
import { wrap } from '../utils/wrap';

export interface SessionHandlerDeps {
  readonly sessionService: ISessionService;
}

/**
 * 注册 Session 域 IPC handler
 *
 * 4 个 channel 对应会话持久化的 4 个用户操作：
 * - session:list   → 分页列出所有会话（按 updatedAt 倒序）
 * - session:get    → 获取指定会话的完整消息历史
 * - session:delete → 删除指定会话（级联删除消息）
 * - session:rename → 重命名会话标题
 *
 * create / appendMessage 是内部 API（供 AgentService 调用），不通过 IPC 暴露。
 */
export function registerSessionHandlers(deps: SessionHandlerDeps): void {
  const { sessionService } = deps;

  // session:list - 分页列出会话
  wrap<SessionListReq, SessionListRes>(
    IPC_CHANNELS.SESSION_LIST,
    SessionListReqSchema,
    async (input) => {
      return sessionService.list(input.limit, input.offset);
    },
  );

  // session:get - 获取完整会话消息历史
  wrap<SessionGetReq, SessionGetRes>(
    IPC_CHANNELS.SESSION_GET,
    SessionGetReqSchema,
    async (input) => {
      return sessionService.get(input.id);
    },
  );

  // session:delete - 删除会话（级联删除消息）
  wrap<SessionDeleteReq, SessionDeleteRes>(
    IPC_CHANNELS.SESSION_DELETE,
    SessionDeleteReqSchema,
    async (input) => {
      return sessionService.delete(input.id);
    },
  );

  // session:rename - 重命名会话标题
  wrap<SessionRenameReq, SessionRenameRes>(
    IPC_CHANNELS.SESSION_RENAME,
    SessionRenameReqSchema,
    async (input) => {
      return sessionService.rename(input.id, input.title);
    },
  );
}
