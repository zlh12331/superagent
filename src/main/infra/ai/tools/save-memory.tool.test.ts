// src/main/infra/ai/tools/save-memory.tool.test.ts
// save_memory 工具单测：显式记忆条目经 capture 写入 L0
// ──────────────────────────────────────────────────────────────

import { describe, expect, it, vi } from 'vitest';
import type { ZodType } from 'zod';

import type { MemoryPort } from '../../memory-hub/types';
import { createSaveMemoryTool } from './save-memory.tool';
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
  const capture = vi.fn(async () => ({ l0Recorded: 1, schedulerNotified: true }));
  const port = { capture } as unknown as MemoryPort;
  return { tool: createSaveMemoryTool(port), capture, port };
}

describe('createSaveMemoryTool', () => {
  it('保存成功：capture 返回已记录 → 标题"记忆已保存" + 输出含内容', async () => {
    const { tool, capture } = createTool();
    const result = await tool.execute({ content: '用户偏好深色主题' }, createCtx());
    expect(result.title).toBe('记忆已保存');
    expect(result.output).toContain('用户偏好深色主题');
    expect(capture).toHaveBeenCalledWith({
      sessionKey: 'sess-1',
      userContent: '请记住（fact）：用户偏好深色主题',
      assistantContent: '已记录该记忆。',
    });
  });

  it('kind=preference：包装文案使用 preference', async () => {
    const { tool, capture } = createTool();
    await tool.execute({ content: '喜欢用 pnpm', kind: 'preference' }, createCtx('sess-9'));
    expect(capture).toHaveBeenCalledWith({
      sessionKey: 'sess-9',
      userContent: '请记住（preference）：喜欢用 pnpm',
      assistantContent: '已记录该记忆。',
    });
  });

  it('保存失败：l0Recorded=0 → 标题"记忆保存失败"', async () => {
    const { tool, capture } = createTool();
    capture.mockResolvedValueOnce({ l0Recorded: 0, schedulerNotified: false });
    const result = await tool.execute({ content: '内容' }, createCtx());
    expect(result.title).toBe('记忆保存失败');
  });

  it('超长内容输出截断到 100 字符', async () => {
    const { tool } = createTool();
    const long = 'x'.repeat(200);
    const result = await tool.execute({ content: long }, createCtx());
    expect(result.output.length).toBeLessThanOrEqual('已保存记忆（fact）：'.length + 100);
  });

  it('schema 校验：空 content 拒绝', () => {
    const { tool } = createTool();
    const parsed = (tool.inputSchema as ZodType).safeParse({ content: '' });
    expect(parsed.success).toBe(false);
  });
});
