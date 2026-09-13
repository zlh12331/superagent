// src/main/ipc/memory.handler.ts
// 记忆域 IPC handler（memory:list / clear / clearAll / status，定义表驱动）
// ──────────────────────────────────────────────────────────────
// - memory:list      按会话列出 L0 对话记录（读审计镜像 JSONL）
// - memory:clear     清除会话记忆（上游 /v2/conversation/delete 按 session_key）
// - memory:clearAll  清空全部会话（枚举会话后批量删；上游无全清接口）
// - memory:status    引擎状态（配置/运行/健康/数据量）+ 用户开关状态
// ──────────────────────────────────────────────────────────────

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import type { L0Record } from '../infra/memory-hub/memory-hub-service';
import type { MemoryClearResult } from '../infra/memory-hub/types';
import type { IpcHandlerContext } from '../utils/wrap';

/** 单次批量删除的会话数上限（对齐上游 conversationDelete 的 session_ids max 100） */
const CLEAR_ALL_BATCH_SIZE = 100;

/** 引擎状态查询依赖（由 ServiceContainer 提供） */
export interface MemoryStatusDeps {
  /** 用户开关（settings.memory.enabled，默认 true） */
  readonly isEnabled: () => boolean;
  /** 引擎是否随包提供 */
  readonly isAvailable: () => boolean;
  /** sidecar 是否已运行（不触发启动） */
  readonly isRunning: () => boolean;
  /** 已运行时探测 /health（未运行时调用方不应调用；失败返回 false） */
  readonly isHealthy: () => Promise<boolean>;
  /** 数据量统计（读审计镜像，不触发引擎） */
  readonly countRecords: () => Promise<{ sessionCount: number; recordCount: number }>;
}

/**
 * 记忆域 handler 工厂（依赖注入：L0 读取器 / 清除器由 ServiceContainer 提供）
 */
export function createMemoryHandlers(params: {
  /** 按会话读取 L0 对话记录（读上游数据文件；无则返回空数组） */
  listL0BySession: (sessionKey: string, limit?: number) => Promise<L0Record[]>;
  /** 按会话删除 L0 对话记录（上游 /v2/conversation/delete；失败返回 ok=false 不抛错） */
  clearBySession: (sessionKey: string) => Promise<MemoryClearResult>;
  /** 列出审计镜像中的全部会话 key（清空全部时枚举用） */
  listKnownSessionKeys: () => Promise<string[]>;
  /** 引擎状态依赖 */
  readonly status: MemoryStatusDeps;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['memory'] {
  const { listL0BySession, clearBySession, listKnownSessionKeys, status } = params;

  /** 批量删除（按上游 100 上限分批；返回累计会话数与删除条数） */
  async function clearSessionsInBatches(
    sessionKeys: readonly string[],
  ): Promise<{ failed: string[]; clearedSessions: number; deletedCount: number }> {
    const failed: string[] = [];
    let clearedSessions = 0;
    let deletedCount = 0;
    for (let i = 0; i < sessionKeys.length; i += CLEAR_ALL_BATCH_SIZE) {
      const batch = sessionKeys.slice(i, i + CLEAR_ALL_BATCH_SIZE);
      for (const key of batch) {
        const result = await clearBySession(key);
        if (result.ok) {
          clearedSessions += 1;
          deletedCount += result.deletedCount;
        } else {
          failed.push(key);
        }
      }
    }
    return { failed, clearedSessions, deletedCount };
  }

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

    // 清除会话记忆（真实删除 L0；引擎不可用/失败时 ok=false）
    clear: async (input) => {
      const result = await clearBySession(input.sessionId);
      return { ok: result.ok, ...(result.ok ? { deletedCount: result.deletedCount } : {}) };
    },

    // 清空全部会话记忆（枚举审计镜像中的会话 → 分批删除）
    clearAll: async () => {
      const keys = await listKnownSessionKeys();
      if (keys.length === 0) {
        return { ok: true, clearedSessions: 0, deletedCount: 0 };
      }
      const { failed, clearedSessions, deletedCount } = await clearSessionsInBatches(keys);
      if (failed.length > 0) {
        return {
          ok: false,
          clearedSessions,
          deletedCount,
          message: `${failed.length} 个会话清除失败（共 ${keys.length} 个）`,
        };
      }
      return { ok: true, clearedSessions, deletedCount };
    },

    // 引擎状态（不触发启动；running=false 时不探测健康）
    status: async () => {
      const running = status.isRunning();
      const healthy = running ? await status.isHealthy() : false;
      const { sessionCount, recordCount } = await status.countRecords();
      return {
        enabled: status.isEnabled(),
        available: status.isAvailable(),
        running,
        healthy,
        sessionCount,
        recordCount,
      };
    },
  };
}
