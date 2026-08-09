// src/main/infra/ai/tools/lsp-tools.test.ts
// LSP 工具单测：真实 fake 语言服务器 + LspServerManager 注入（无 mock 框架）

import { afterEach, describe, expect, it } from 'vitest';
import { LspServerManager } from '../../lsp/lsp-server-manager';
import { createLspDefinitionTool } from './lsp-definition.tool';
import { createLspReferencesTool } from './lsp-references.tool';
import type { ToolContext } from './tool';

/** fake 语言服务器脚本（真实 JSON-RPC 2.0 over stdio） */
const FAKE_SERVER_SCRIPT = `
let buffer = '';
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
}
function handle(body) {
  const msg = JSON.parse(body);
  if (msg.method === 'initialize') {
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    return;
  }
  if (msg.id === undefined) { return; }
  switch (msg.method) {
    case 'textDocument/definition':
      send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///proj/src/a.ts', range: { start: { line: 4, character: 0 }, end: { line: 4, character: 3 } } }] });
      break;
    case 'textDocument/references':
      send({ jsonrpc: '2.0', id: msg.id, result: [
        { uri: 'file:///proj/src/a.ts', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 1 } } },
        { uri: 'file:///proj/src/b.ts', range: { start: { line: 9, character: 0 }, end: { line: 9, character: 1 } } },
      ] });
      break;
    case 'shutdown':
      send({ jsonrpc: '2.0', id: msg.id, result: null });
      break;
    default:
      send({ jsonrpc: '2.0', id: msg.id, result: null });
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const headerEnd = buffer.indexOf('\\r\\n\\r\\n');
    if (headerEnd === -1) { break; }
    const match = /Content-Length: (\\d+)/i.exec(buffer.slice(0, headerEnd));
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) { break; }
    handle(buffer.slice(start, start + length));
    buffer = buffer.slice(start + length);
  }
});
`;

function makeCtx(): ToolContext {
  return {
    sessionId: 's1',
    workingDir: 'D:\\proj',
    userPrompt: undefined,
  } as unknown as ToolContext;
}

describe('LSP 工具', () => {
  const managers: LspServerManager[] = [];

  afterEach(async () => {
    for (const manager of managers) {
      await manager.disposeAll();
    }
    managers.length = 0;
  });

  function createManager(): LspServerManager {
    const manager = new LspServerManager({
      command: process.execPath,
      args: ['-e', FAKE_SERVER_SCRIPT],
    });
    managers.push(manager);
    return manager;
  }

  it('lsp_definition：返回声明位置（行号 +1 展示）', async () => {
    const tool = createLspDefinitionTool(createManager());
    const result = await tool.execute(
      { filePath: 'D:\\proj\\src\\main.ts', line: 0, character: 0 },
      makeCtx(),
    );
    expect(result.title).toContain('1 处');
    expect(result.output).toContain('a.ts');
    expect(result.output).toContain('5:1'); // line 4 + 1 = 5, character 0 + 1 = 1
  });

  it('lsp_references：多引用位置', async () => {
    const tool = createLspReferencesTool(createManager());
    const result = await tool.execute(
      { filePath: 'D:\\proj\\src\\main.ts', line: 0, character: 0 },
      makeCtx(),
    );
    expect(result.title).toContain('2 处');
    expect(result.output).toContain('b.ts');
  });

  it('服务器不可用：返回明确错误（不抛异常）', async () => {
    // 命令不存在 → 启动失败 → 明确错误
    const manager = new LspServerManager({
      command: 'nonexistent-server-binary-xyz',
      args: ['--stdio'],
      timeoutMs: 500,
    });
    managers.push(manager);
    const tool = createLspDefinitionTool(manager);
    const result = await tool.execute(
      { filePath: 'D:\\proj\\src\\main.ts', line: 0, character: 0 },
      makeCtx(),
    );
    expect(result.title).toContain('失败');
    expect(result.output).toContain('不可用');
  });
});
