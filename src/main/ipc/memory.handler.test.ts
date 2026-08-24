// src/main/ipc/memory.handler.test.ts
// memory.handler 单测：memory:list 按会话列出 L0 + memory:clear 幂等
// ──────────────────────────────────────────────────────────────
// 测试策略：L0 读取器为外部依赖 → 注入 fake；handler 业务逻辑保持真实
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { L0Record } from '../infra/memory-hub/memory-hub-service';
import { createMemoryHandlers } from './memory.handler';

function createHandlers(records: L0Record[] = []) {
  const listL0BySession = vi.fn(async () => records);
  const handlers = createMemoryHandlers({ listL0BySession });
  return { handlers, listL0BySession };
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
  it('返回 ok=true（上游批量删除端点待接，先幂等留痕）', async () => {
    const { handlers } = createHandlers();
    const res = await handlers.clear({ sessionId: 'sess-1' }, {} as never);
    expect(res).toEqual({ ok: true });
  });
});
