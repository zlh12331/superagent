// src/main/ipc/memory.handler.ts
// 记忆域 IPC handler（memory:list / clear，定义表驱动）
// ──────────────────────────────────────────────
// 实现 2 个请求-响应方法：
// - memory:list   列出会话记忆（设置页/记忆面板展示）
// - memory:clear  清除会话记忆（幂等）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { MemoryService } from '../infra/ai/memory-service';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 记忆域 handler 工厂（依赖注入：MemoryService 由 ServiceContainer 持有）
 */
export function createMemoryHandlers(params: {
  memoryService: MemoryService;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['memory'] {
  const { memoryService } = params;
  return {
    // 列出会话记忆
    list: async (input) => {
      const memories = await memoryService.recall(input.sessionId);
      return {
        memories: memories.map((m) => ({
          id: m.id,
          sessionId: m.sessionId,
          content: m.content,
          kind: m.kind,
          createdAt: m.createdAt,
        })),
      };
    },

    // 清除会话记忆（幂等）
    clear: async (input) => {
      await memoryService.clear(input.sessionId);
      return { ok: true };
    },
  };
}
