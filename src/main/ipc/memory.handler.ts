// src/main/ipc/memory.handler.ts
// 记忆域 IPC handler（memory:list / clear，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 2 个请求-响应方法（数据源：MemoryHub 记忆引擎）：
// - memory:list   检索会话相关记忆（设置页/记忆面板展示）
// - memory:clear  清除会话记忆（上游 beta 暂无按 session 的批量删除端点，
//                 过渡实现：幂等返回成功并留痕日志，待上游补齐后接入）
//
// 门面契约保持不变（MemoryInfo 形状），仅底层数据源切换。

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { MemoryPort } from '../infra/memory-hub/types';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 记忆域 handler 工厂（依赖注入：端口解析器由 ServiceContainer 提供）
 */
export function createMemoryHandlers(params: {
  getPort: () => MemoryPort | Promise<MemoryPort>;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['memory'] {
  const { getPort } = params;
  return {
    // 列出会话记忆（L0 会话内容检索 + L1 结构化记忆合并展示）
    list: async (input) => {
      const port = await getPort();
      const [conversations, memories] = await Promise.all([
        port.searchConversations(input.sessionId, 20),
        port.searchMemories(input.sessionId, 20),
      ]);
      const items: Array<{
        id: number;
        sessionId: string;
        content: string;
        kind: string;
        createdAt: number;
      }> = [];
      if (memories.content.trim().length > 0) {
        items.push({
          id: 1,
          sessionId: input.sessionId,
          content: memories.content.trim(),
          kind: 'fact',
          createdAt: Date.now(),
        });
      }
      if (conversations.content.trim().length > 0) {
        items.push({
          id: 2,
          sessionId: input.sessionId,
          content: conversations.content.trim(),
          kind: 'preference',
          createdAt: Date.now(),
        });
      }
      return { memories: items };
    },

    // 清除会话记忆（幂等；上游批量删除端点待接，先留痕）
    clear: async (input) => {
      logger.warn(
        { sessionId: input.sessionId },
        '[memory-hub] clear 请求（上游暂无按会话清除端点，已留痕）',
      );
      return { ok: true };
    },
  };
}
