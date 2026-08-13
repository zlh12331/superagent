// src/main/infra/ai/tools/terminal.tool.test.ts
// terminal 工具补测：schema 序列化回归（DeepSeek 400）+ 扁平 schema 参数守卫

import { jsonSchema } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createTerminalTool } from './terminal.tool';
import type { ToolContext } from './tool';

/** 真实 stub 的最小 terminalService（业务逻辑不 mock，注入 fake 服务） */
function createFakeTerminalService() {
  return {
    create: vi.fn(async () => ({ terminalId: 't-1', pid: 42 })),
    input: vi.fn(async () => ({ ok: true })),
    getOutput: vi.fn(() => 'hello output'),
    clearOutput: vi.fn(),
    resize: vi.fn(async () => ({ ok: true })),
    kill: vi.fn(async () => ({ ok: true })),
  };
}

function createCtx(): ToolContext {
  return {
    workingDir: 'F:\\proj',
    sessionId: 's-1',
    messageId: 'msg-1',
    callId: 'call-1',
    abortSignal: new AbortController().signal,
    webContents: {} as never,
    mode: 'build',
  };
}

describe('terminal 工具', () => {
  it('回归（DeepSeek 400）：JSON Schema 顶层类型为 object 而非 null', () => {
    const tool = createTerminalTool(createFakeTerminalService() as never);
    const out = jsonSchema(tool.inputSchema as never) as unknown as {
      jsonSchema: { type?: unknown };
    };
    expect(out.jsonSchema.type).toBe('object');
  });

  it('create：cols/rows 缺省回退 80/24；command 可选', async () => {
    const svc = createFakeTerminalService();
    const tool = createTerminalTool(svc as never);
    const result = await tool.execute({ action: 'create' }, createCtx());
    expect(svc.create).toHaveBeenCalledWith(
      expect.objectContaining({ cols: 80, rows: 24, command: undefined, cwd: 'F:\\proj' }),
    );
    expect(result.title).toContain('创建终端');
  });

  it('input 缺 terminalId/data：返回参数缺失错误（不抛）', async () => {
    const svc = createFakeTerminalService();
    const tool = createTerminalTool(svc as never);
    const result = await tool.execute({ action: 'input' }, createCtx());
    expect(result.title).toBe('参数缺失');
    expect(svc.input).not.toHaveBeenCalled();
  });

  it('input 参数齐全：写入终端服务', async () => {
    const svc = createFakeTerminalService();
    const tool = createTerminalTool(svc as never);
    const result = await tool.execute(
      { action: 'input', terminalId: 't-1', data: 'ls' },
      createCtx(),
    );
    expect(svc.input).toHaveBeenCalledWith('t-1', 'ls');
    expect(result.metadata).toMatchObject({ ok: true });
  });

  it('kill 缺 terminalId：返回参数缺失错误', async () => {
    const svc = createFakeTerminalService();
    const tool = createTerminalTool(svc as never);
    const result = await tool.execute({ action: 'kill' }, createCtx());
    expect(result.title).toBe('参数缺失');
    expect(svc.kill).not.toHaveBeenCalled();
  });

  it('resize 参数齐全：调用 resize 服务', async () => {
    const svc = createFakeTerminalService();
    const tool = createTerminalTool(svc as never);
    await tool.execute({ action: 'resize', terminalId: 't-1', cols: 120, rows: 40 }, createCtx());
    expect(svc.resize).toHaveBeenCalledWith('t-1', 120, 40);
  });
});
