import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { INVALIDATION_DOMAINS } from '@code-agent/shared/main';
import { broadcastInvalidation } from '../infra/invalidation/invalidation';
import type { L0Record } from '../infra/memory-hub/memory-hub-service';
import type { MemoryClearResult } from '../infra/memory-hub/types';
import type { IpcHandlerContext } from '../utils/wrap';

export interface MemoryStatusDeps {
  readonly isEnabled: () => boolean;
  readonly isAvailable: () => boolean;
  readonly isRunning: () => boolean;
  readonly isHealthy: () => Promise<boolean>;
  readonly countRecords: () => Promise<{ sessionCount: number; recordCount: number }>;
}

export function createMemoryHandlers(params: {
  listL0BySession: (sessionKey: string, limit?: number) => Promise<L0Record[]>;
  clearBySession: (sessionKey: string) => Promise<MemoryClearResult>;
  clearEngineBySession: (sessionKey: string) => Promise<MemoryClearResult>;
  removeL0Jsonl: (sessionKeys: readonly string[]) => Promise<number>;
  listKnownSessionKeys: () => Promise<string[]>;
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
