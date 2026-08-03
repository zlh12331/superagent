// src/main/ipc/session.handler.ts
// Session 域 IPC handler：会话持久化查询通道（定义表驱动）
//
// 职责：
// - 实现 6 个 session:* 请求-响应方法
// - 把 IPC 调用委托给 SessionService
//
// 设计：
// - 与 GitHandler / CodebaseHandler 一致的 DI 模式
// - SessionHandlerDeps 接口声明依赖，便于测试 mock
// - 不持有状态，所有调用转发给 SessionService
//
// 注意：
// - SessionService 的 appendMessage 是内部 API（非 IPC 通道）
//   由 AgentService / ChatService 直接调用，不在此 handler 中注册

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { ISessionService } from '../infra/storage/session-service';
import type { IpcHandlerContext } from '../utils/wrap';

export interface SessionHandlerDeps {
  readonly sessionService: ISessionService;
}

/**
 * 创建 Session 域 handler 实现
 *
 * 6 个方法对应会话持久化的用户操作：
 * - list            → 分页列出所有会话（按 updatedAt 倒序）
 * - get             → 获取指定会话的完整消息历史
 * - delete          → 删除指定会话（级联删除消息）
 * - rename          → 重命名会话标题
 * - create          → 创建新会话（绑定 workingDir，空会话）
 * - listRecentDirs  → 查询最近使用的目录列表（去重 + 按 lastUsed 倒序）
 *
 * appendMessage 是内部 API（供 AgentService 调用），不通过 IPC 暴露。
 */
export function createSessionHandlers(
  deps: SessionHandlerDeps,
): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['session'] {
  const { sessionService } = deps;

  return {
    // session:list - 分页列出会话
    list: async (input) => {
      return sessionService.list(input.limit, input.offset);
    },

    // session:get - 获取完整会话消息历史
    get: async (input) => {
      return sessionService.get(input.id);
    },

    // session:delete - 删除会话（级联删除消息）
    delete: async (input) => {
      return sessionService.delete(input.id);
    },

    // session:rename - 重命名会话标题
    rename: async (input) => {
      return sessionService.rename(input.id, input.title);
    },

    // session:create - 创建新会话（绑定 workingDir，空会话）
    create: async (input) => {
      const sessionId = await sessionService.create({
        workingDir: input.workingDir,
        title: input.title,
        messages: undefined,
      });
      return { sessionId };
    },

    // session:listRecentDirs - 查询最近使用的目录列表
    listRecentDirs: async (input) => {
      return sessionService.listRecentDirs({ limit: input.limit });
    },
  };
}
