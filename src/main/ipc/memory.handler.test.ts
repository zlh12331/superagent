// src/main/ipc/memory.handler.test.ts
// memory.handler 单测：list（按会话列 L0）/ clear（会话级删除）/ clearAll（全量）
//   / status（引擎状态与开关）
// ──────────────────────────────────────────────────────────────
// 测试策略：L0 读取器 / 引擎清除器 / JSONL 清理器 / 会话枚举 / 状态依赖为外部
//   依赖 → 注入 fake；handler 业务逻辑（逐 key 删除聚合、JSONL 单遍清理编排、
//   状态聚合）保持真实
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import { broadcastInvalidation } from '../infra/invalidation/invalidation';
import type { L0Record } from '../infra/memory-hub/memory-hub-service';
import type { MemoryClearResult } from '../infra/memory-hub/types';
import { createMemoryHandlers, type MemoryStatusDeps } from './memory.handler';

// 失效域广播替身（基础设施边界，规范允许 vi.mock；S9 断言用）
vi.mock('../infra/invalidation/invalidation', () => ({ broadcastInvalidation: vi.fn() }));

/** 创建 fake 状态依赖（各方法可被用例覆盖） */
function createStatusDeps(overrides: Partial<MemoryStatusDeps> = {}): MemoryStatusDeps {
  return {
    isEnabled: () => true,
    isAvailable: () => true,
    isRunning: () => false,
    isHealthy: async () => false,
    countRecords: async () => ({ sessionCount: 0, recordCount: 0 }),
    ...overrides,
  };
}

function createHandlers(
  records: L0Record[] = [],
  options: {
    clearImpl?: (sessionKey: string) => Promise<MemoryClearResult>;
    engineClearImpl?: (sessionKey: string) => Promise<MemoryClearResult>;
    knownSessions?: string[];
    status?: Partial<MemoryStatusDeps>;
  } = {},
) {
  const listL0BySession = vi.fn(async () => records);
  const clearBySession = vi.fn(async (sessionKey: string): Promise<MemoryClearResult> => {
    if (options.clearImpl !== undefined) return options.clearImpl(sessionKey);
    return { ok: true, deletedCount: 0 };
  });
  const engineClear = vi.fn(async (sessionKey: string): Promise<MemoryClearResult> => {
    if (options.engineClearImpl !== undefined) return options.engineClearImpl(sessionKey);
    return { ok: true, deletedCount: 0 };
  });
  const removeL0Jsonl = vi.fn(async () => 0);
  const listKnownSessionKeys = vi.fn(async () => options.knownSessions ?? []);
  const handlers = createMemoryHandlers({
    listL0BySession,
    clearBySession,
    clearEngineBySession: engineClear,
    removeL0Jsonl,
    listKnownSessionKeys,
    status: createStatusDeps(options.status),
  });
  return {
    handlers,
    listL0BySession,
    clearBySession,
    engineClear,
    removeL0Jsonl,
    listKnownSessionKeys,
  };
}

describe('memory:list', () => {
  it('按会话读取 L0 记录 → 返回 memories（kind=conversation，content 原样）', async () => {
    const records: L0Record[] = [
      { role: 'user', content: '用户问题', timestamp: 1000 },
      { role: 'assistant', content: '助手回答', timestamp: 2000 },
    ];
    const { handlers, listL0BySession } = createHandlers(records);

    const res = await handlers.list({ sessionId: 'sess-1' }, {} as never);
    expect(listL0BySession).toHaveBeenCalledWith('sess-1', 20);
    expect(res.memories).toHaveLength(2);
    expect(res.memories[0]).toMatchObject({
      sessionId: 'sess-1',
      content: '用户问题',
      kind: 'conversation',
      createdAt: 1000,
    });
    expect(res.memories[1]).toMatchObject({ content: '助手回答' });
  });

  it('无记录 → 返回空列表', async () => {
    const { handlers } = createHandlers([]);
    const res = await handlers.list({ sessionId: 'sess-empty' }, {} as never);
    expect(res.memories).toEqual([]);
  });

  it('timestamp 为 0 时 id 回退为序号（保证 React key 唯一）', async () => {
    const { handlers } = createHandlers([{ role: 'user', content: 'x', timestamp: 0 }]);
    const res = await handlers.list({ sessionId: 'sess-1' }, {} as never);
    expect(res.memories[0]?.id).toBe(1);
  });
});

describe('memory:clear', () => {
  it('成功：转发 sessionId → 返回 ok + deletedCount', async () => {
    const { handlers, clearBySession } = createHandlers();
    clearBySession.mockResolvedValueOnce({ ok: true, deletedCount: 3 });
    const res = await handlers.clear({ sessionId: 'sess-1' }, {} as never);
    expect(clearBySession).toHaveBeenCalledWith('sess-1');
    expect(res).toEqual({ ok: true, deletedCount: 3 });
  });

  it('失败：引擎不可用 → 返回 ok=false（不带 deletedCount）', async () => {
    const { handlers, clearBySession } = createHandlers();
    clearBySession.mockResolvedValueOnce({ ok: false, deletedCount: 0, message: '引擎未配置' });
    const res = await handlers.clear({ sessionId: 'sess-2' }, {} as never);
    expect(res).toEqual({ ok: false });
  });

  it('失效域声明（31 号 spec S9）：成功清除 → 广播 memory；失败不广播', async () => {
    const { handlers, clearBySession } = createHandlers();
    clearBySession.mockResolvedValueOnce({ ok: true, deletedCount: 3 });

    await handlers.clear({ sessionId: 'sess-1' }, {} as never);
    expect(broadcastInvalidation).toHaveBeenCalledWith(['memory']);

    vi.mocked(broadcastInvalidation).mockClear();
    clearBySession.mockResolvedValueOnce({ ok: false, deletedCount: 0, message: '引擎未配置' });
    await handlers.clear({ sessionId: 'sess-2' }, {} as never);
    expect(broadcastInvalidation).not.toHaveBeenCalled();
  });
});

describe('memory:clearAll', () => {
  it('无会话数据 → ok=true 且计数为 0（不调用清除）', async () => {
    const { handlers, engineClear } = createHandlers([], { knownSessions: [] });
    const res = await handlers.clearAll({}, {} as never);
    expect(res).toEqual({ ok: true, clearedSessions: 0, deletedCount: 0 });
    expect(engineClear).not.toHaveBeenCalled();
  });

  it('多个会话 → 逐 key 引擎删除并累计，JSONL 清理单遍批量做（P2-26）', async () => {
    const { handlers, engineClear, removeL0Jsonl } = createHandlers([], {
      knownSessions: ['s1', 's2', 's3'],
      engineClearImpl: async () => ({ ok: true, deletedCount: 2 }),
    });
    const res = await handlers.clearAll({}, {} as never);
    expect(res).toEqual({ ok: true, clearedSessions: 3, deletedCount: 6 });
    expect(engineClear).toHaveBeenCalledTimes(3);
    // JSONL 清理一次性拿到全部 key（单遍扫描），不再每 key 一次
    expect(removeL0Jsonl).toHaveBeenCalledTimes(1);
    expect(removeL0Jsonl).toHaveBeenCalledWith(['s1', 's2', 's3']);
  });

  it('部分失败（ok=false）→ 该 key 仍参与 JSONL 清理，报告成功数与失败会话数', async () => {
    const { handlers, removeL0Jsonl } = createHandlers([], {
      knownSessions: ['ok1', 'bad', 'ok2'],
      engineClearImpl: async (key) =>
        key === 'bad'
          ? { ok: false, deletedCount: 0, message: 'boom' }
          : { ok: true, deletedCount: 1 },
    });
    const res = await handlers.clearAll({}, {} as never);
    expect(res.ok).toBe(false);
    expect(res.clearedSessions).toBe(2);
    expect(res.deletedCount).toBe(2);
    expect(res.message).toContain('1 个会话清除失败');
    // 引擎删除已返回（即便 ok=false）的 key 参与镜像清理——与原语义一致
    expect(removeL0Jsonl).toHaveBeenCalledWith(['ok1', 'bad', 'ok2']);
  });

  it('引擎单 key 抛错 → 该 key 失败且不参与 JSONL 清理，其余 key 照常', async () => {
    const { handlers, removeL0Jsonl } = createHandlers([], {
      knownSessions: ['ok1', 'bad', 'ok2'],
      engineClearImpl: async (key) => {
        if (key === 'bad') throw new Error('engine gone');
        return { ok: true, deletedCount: 1 };
      },
    });
    const res = await handlers.clearAll({}, {} as never);
    expect(res.ok).toBe(false);
    expect(res.clearedSessions).toBe(2);
    expect(res.message).toContain('1 个会话清除失败');
    expect(removeL0Jsonl).toHaveBeenCalledWith(['ok1', 'ok2']);
  });

  it('引擎不可用（全部抛错）→ 全部失败且不做 JSONL 清理', async () => {
    const { handlers, removeL0Jsonl } = createHandlers([], {
      knownSessions: ['s1', 's2'],
      engineClearImpl: async () => {
        throw new Error('sidecar 冷启动失败');
      },
    });
    const res = await handlers.clearAll({}, {} as never);
    expect(res.ok).toBe(false);
    expect(res.clearedSessions).toBe(0);
    expect(res.message).toContain('2 个会话清除失败');
    expect(removeL0Jsonl).not.toHaveBeenCalled();
  });

  it('失效域声明（31 号 spec S9）：有真实删除 → 广播 memory；全失败不广播', async () => {
    const okCase = createHandlers([], {
      knownSessions: ['s1', 's2'],
      engineClearImpl: async () => ({ ok: true, deletedCount: 1 }),
    });
    await okCase.handlers.clearAll({}, {} as never);
    expect(broadcastInvalidation).toHaveBeenCalledWith(['memory']);

    vi.mocked(broadcastInvalidation).mockClear();
    const failCase = createHandlers([], {
      knownSessions: ['s1'],
      engineClearImpl: async () => {
        throw new Error('engine gone');
      },
    });
    await failCase.handlers.clearAll({}, {} as never);
    expect(broadcastInvalidation).not.toHaveBeenCalled();
  });
});

describe('memory:status', () => {
  it('引擎未运行 → running=false 且不探测健康（healthy=false）', async () => {
    const isHealthy = vi.fn(async () => true); // 不应被调用
    const { handlers } = createHandlers([], {
      status: { isRunning: () => false, isHealthy },
    });
    const res = await handlers.status({}, {} as never);
    expect(res.running).toBe(false);
    expect(res.healthy).toBe(false);
    expect(isHealthy).not.toHaveBeenCalled();
  });

  it('引擎运行中 → 探测健康并回传', async () => {
    const { handlers } = createHandlers([], {
      status: { isRunning: () => true, isHealthy: async () => true },
    });
    const res = await handlers.status({}, {} as never);
    expect(res).toMatchObject({ running: true, healthy: true });
  });

  it('汇总开关/可用性/数据量', async () => {
    const { handlers } = createHandlers([], {
      status: {
        isEnabled: () => false,
        isAvailable: () => true,
        countRecords: async () => ({ sessionCount: 4, recordCount: 12 }),
      },
    });
    const res = await handlers.status({}, {} as never);
    expect(res).toMatchObject({
      enabled: false,
      available: true,
      sessionCount: 4,
      recordCount: 12,
    });
  });
});
