// src/main/ipc/memory.handler.ts
// 记忆域 IPC handler（memory:list / clear，定义表驱动）
// ──────────────────────────────────────────────────────────────
// 实现 2 个请求-响应方法（数据源：MemoryHub 记忆引擎）：
// - memory:list   按会话列出 L0 对话记录（读上游落盘 JSONL，设置页/记忆面板展示）
// - memory:clear  清除会话记忆（上游 beta 暂无按 session 的批量删除端点，
//                 过渡实现：幂等返回成功并留痕日志，待上游补齐后接入）
//
// 门面契约保持不变（MemoryInfo 形状），仅底层数据源切换。
// 注：上游 gateway 的 /search/conversations 是"语义检索"（query 必填），
//     无法"按会话列出"；因此列表展示直接读上游落盘的 L0 数据文件。

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import type { L0Record } from '../infra/memory-hub/memory-hub-service';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 记忆域 handler 工厂（依赖注入：L0 读取器由 ServiceContainer 提供）
 */
export function createMemoryHandlers(params: {
  /** 按会话读取 L0 对话记录（读上游数据文件；无则返回空数组） */
  listL0BySession: (sessionKey: string, limit?: number) => Promise<L0Record[]>;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['memory'] {
  const { listL0BySession } = params;
  return {
    // 列出会话记忆（L0 对话记录，按会话精确读取）
    list: async (input) => {
      const records = await listL0BySession(input.sessionId, 20);
      const items = records.map((r, index) => ({
        id: r.timestamp !== 0 ? r.timestamp : index + 1,
        sessionId: input.sessionId,
        content: r.content,
        kind: 'conversation',
        createdAt: r.timestamp,
      }));
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
