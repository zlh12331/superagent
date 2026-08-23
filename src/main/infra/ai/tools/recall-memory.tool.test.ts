// src/main/infra/ai/tools/recall-memory.tool.test.ts
// recall_memory 工具单测：按需检索跨会话记忆（只读）
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';

import type { MemoryPort } from '../../memory-hub/types';
import { createRecallMemoryTool } from './recall-memory.tool';
import type { ToolContext } from './tool';

function createCtx(sessionId = 'sess-1'): ToolContext {
  return {
    workingDir: 'C:\\work',
    sessionId,
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    mode: 'build',
  };
}

function createTool() {
  const recall = vi.fn(async () => ({ ok: true, context: '召回上下文', memoryCount: 3 }));
  const port = { recall } as unknown as MemoryPort;
  return { tool: createRecallMemoryTool(port), recall };
}

describe('createRecallMemoryTool', () => {
  it('命中记忆：标题含条数 + 输出为引擎上下文', async () => {
    const { tool, recall } = createTool();
    const result = await tool.execute({ query: '项目约定' }, createCtx());
    expect(result.title).toBe('记忆检索（3 条）');
    expect(result.output).toBe('召回上下文');
    expect(recall).toHaveBeenCalledWith({ query: '项目约定' });
  });

  it('ok=true 但上下文为空 → "未找到相关记忆"', async () => {
    const { tool, recall } = createTool();
    recall.mockResolvedValueOnce({ ok: true, context: '', memoryCount: 0 });
    const result = await tool.execute({ query: 'q' }, createCtx());
    expect(result.title).toBe('记忆检索');
    expect(result.output).toBe('未找到相关记忆。');
  });

  it('ok=false → "未找到相关记忆"', async () => {
    const { tool, recall } = createTool();
    recall.mockResolvedValueOnce({ ok: false, context: '', memoryCount: 0, message: 'x' });
    const result = await tool.execute({ query: 'q' }, createCtx());
    expect(result.title).toBe('记忆检索');
    expect(result.output).toBe('未找到相关记忆。');
  });

  it('schema 校验：空 query 拒绝', () => {
    const { tool } = createTool();
    const parsed = tool.inputSchema.safeParse({ query: '' });
    expect(parsed.success).toBe(false);
  });
});
