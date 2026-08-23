// src/main/ipc/memory.handler.test.ts
// memory.handler 单测：memory:list 合并展示 + memory:clear 幂等
// ──────────────────────────────────────────────────────────────
// 测试策略：MemoryPort 为外部依赖 → 注入 fake；handler 业务逻辑保持真实
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { MemoryPort } from '../infra/memory-hub/types';
import { createMemoryHandlers } from './memory.handler';

function createFakePort() {
  return {
    searchConversations: vi.fn(async () => ({ content: '', total: 0 })),
    searchMemories: vi.fn(async () => ({ content: '', total: 0 })),
  } as unknown as MemoryPort;
}

function createHandlers(port: MemoryPort, asyncGet = false) {
  const getPort = asyncGet ? async () => port : () => port;
  const handlers = createMemoryHandlers({ getPort });
  return { handlers, port };
}

describe('memory:list', () => {
  it('两类内容均非空 → 合并为 2 条（memories=fact / conversations=preference）', async () => {
    const port = createFakePort();
    port.searchMemories = vi.fn(async () => ({ content: '结构化记忆', total: 1 }));
    port.searchConversations = vi.fn(async () => ({ content: '对话内容', total: 2 }));
    const { handlers } = createHandlers(port);

    const res = await handlers.list({ sessionId: 'sess-1' });
    expect(port.searchMemories).toHaveBeenCalledWith('sess-1', 20);
    expect(port.searchConversations).toHaveBeenCalledWith('sess-1', 20);
    expect(res.memories).toHaveLength(2);
    expect(res.memories[0]).toMatchObject({ id: 1, kind: 'fact', content: '结构化记忆' });
    expect(res.memories[1]).toMatchObject({ id: 2, kind: 'preference', content: '对话内容' });
  });

  it('两类内容均空 → 返回空列表', async () => {
    const port = createFakePort();
    const { handlers } = createHandlers(port);
    const res = await handlers.list({ sessionId: 'sess-empty' });
    expect(res.memories).toEqual([]);
  });

  it('仅对话内容非空 → 只返回 1 条', async () => {
    const port = createFakePort();
    port.searchConversations = vi.fn(async () => ({ content: '仅对话', total: 1 }));
    const { handlers } = createHandlers(port);
    const res = await handlers.list({ sessionId: 'sess-1' });
    expect(res.memories).toHaveLength(1);
    expect(res.memories[0]?.id).toBe(2);
  });

  it('getPort 异步解析也支持', async () => {
    const port = createFakePort();
    port.searchMemories = vi.fn(async () => ({ content: '记忆', total: 1 }));
    const { handlers } = createHandlers(port, true);
    const res = await handlers.list({ sessionId: 'sess-1' });
    expect(res.memories).toHaveLength(1);
  });
});

describe('memory:clear', () => {
  it('返回 ok=true（上游批量删除端点待接，先幂等留痕）', async () => {
    const port = createFakePort();
    const { handlers } = createHandlers(port);
    const res = await handlers.clear({ sessionId: 'sess-1' });
    expect(res).toEqual({ ok: true });
  });
});
