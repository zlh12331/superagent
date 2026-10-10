import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { INVALIDATION_DOMAINS } from '@code-agent/shared/main';
import { broadcastInvalidation } from '../infra/invalidation/invalidation';
import type { L0Record } from '../infra/memory-hub/memory-hub-service';
import type { MemoryClearResult } from '../infra/memory-hub/types';
import type { IpcHandlerContext } from '../utils/wrap';

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
  /** 按会话删除 L0 对话记录（引擎删除 + JSONL 镜像同步清理；失败返回 ok=false 不抛错） */
  clearBySession: (sessionKey: string) => Promise<MemoryClearResult>;
  /**
   * 引擎逐 key 删除（仅 /v2/conversation/delete；ensureStarted 失败/HTTP 异常抛错）
   *
   * clearAll 专用：JSONL 清理由 removeL0Jsonl 单遍统一做（P2-26），
   * 与单 key clearBySession（内联 JSONL 清理）分离。
   */
  clearEngineBySession: (sessionKey: string) => Promise<MemoryClearResult>;
  /** JSONL 审计镜像批量清理（单遍扫描统一重写；P2-26：原每 key 一次全扫全量重写） */
  removeL0Jsonl: (sessionKeys: readonly string[]) => Promise<number>;
  /** 列出审计镜像中的全部会话 key（清空全部时枚举用） */
  listKnownSessionKeys: () => Promise<string[]>;
  /** 引擎状态依赖 */
  readonly status: MemoryStatusDeps;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['memory'] {
  const {
    listL0BySession,
    clearBySession,
    clearEngineBySession,
    removeL0Jsonl,
    listKnownSessionKeys,
    status,
  } = params;

  return {
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

    clear: async (input) => {
      const result = await clearBySession(input.sessionId);
      if (result.ok) {
        broadcastInvalidation([INVALIDATION_DOMAINS.memory]);
      }
      return { ok: result.ok, ...(result.ok ? { deletedCount: result.deletedCount } : {}) };
    },

    clearAll: async () => {
      const keys = await listKnownSessionKeys();
      if (keys.length === 0) {
        return { ok: true, clearedSessions: 0, deletedCount: 0 };
      }
      const failed: string[] = [];
      const jsonlEligible: string[] = [];
      let clearedSessions = 0;
      let deletedCount = 0;
      for (const key of keys) {
        try {
          const result = await clearEngineBySession(key);
          jsonlEligible.push(key);
          if (result.ok) {
            clearedSessions += 1;
            deletedCount += result.deletedCount;
          } else {
            failed.push(key);
          }
        } catch {
          failed.push(key);
        }
      }
      if (jsonlEligible.length > 0) {
        await removeL0Jsonl(jsonlEligible);
      }
      if (clearedSessions > 0 || deletedCount > 0) {
        broadcastInvalidation([INVALIDATION_DOMAINS.memory]);
      }
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
