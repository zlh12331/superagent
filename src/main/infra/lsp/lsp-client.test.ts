// src/main/infra/lsp/lsp-client.test.ts
// LSP 客户端单测：fake 语言服务器（真实 JSON-RPC 子进程，无 mock 框架）

import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LspClient, type LspPosition } from './lsp-client';

/** fake 语言服务器脚本（真实 JSON-RPC 2.0 over stdio） */
const FAKE_SERVER_SCRIPT = `
let buffer = '';
let serverState = null;
function send(message) {
  const body = JSON.stringify(message);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body, 'utf8') + '\\r\\n\\r\\n' + body);
}
function handle(body) {
  const msg = JSON.parse(body);
  if (msg.method === 'initialize') {
    serverState = msg.params;
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } });
    return;
  }
  if (msg.id === undefined) { return; } // 通知忽略
  switch (msg.method) {
    case 'textDocument/definition':
      send({ jsonrpc: '2.0', id: msg.id, result: [{ uri: 'file:///a.ts', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } } }] });
      break;
    case 'textDocument/references':
      send({ jsonrpc: '2.0', id: msg.id, result: [
        { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } },
        { uri: 'file:///b.ts', range: { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } } },
      ] });
      break;
    case 'textDocument/hover':
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: { kind: 'markdown', value: 'hover 内容' } } });
      break;
    case 'textDocument/stall':
      break; // 不回响应（超时测试）
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

/** 启动 fake 服务器并创建客户端 */
async function createTestClient(timeoutMs = 3_000): Promise<LspClient> {
  const child = spawn(process.execPath, ['-e', FAKE_SERVER_SCRIPT]);
  const client = new LspClient({
    command: process.execPath,
    args: ['-e', FAKE_SERVER_SCRIPT],
    rootUri: 'file:///proj',
    timeoutMs,
  });
  await client.initialize();
  void child;
  return client;
}

const POSITION: LspPosition = { line: 0, character: 0 };

describe('LspClient', () => {
  const clients: LspClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      await client.dispose();
    }
    clients.length = 0;
  });

  it('definition：返回归一化位置', async () => {
    const client = await createTestClient();
    clients.push(client);
    const locations = await client.definition('file:///a.ts', POSITION);
    expect(locations).toHaveLength(1);
    expect(locations[0]?.uri).toBe('file:///a.ts');
    expect(locations[0]?.range.start.line).toBe(1);
  });

  it('references：数组归一化（多位置）', async () => {
    const client = await createTestClient();
    clients.push(client);
    const locations = await client.references('file:///a.ts', POSITION);
    expect(locations).toHaveLength(2);
    expect(locations[1]?.uri).toBe('file:///b.ts');
  });

  it('hover：Markdown 内容解析为字符串', async () => {
    const client = await createTestClient();
    clients.push(client);
    const hover = await client.hover('file:///a.ts', POSITION);
    expect(hover?.contents).toBe('hover 内容');
  });

  it('请求超时：无响应超阈值拒绝', async () => {
    const client = await createTestClient(200);
    clients.push(client);
    await expect(client.requestRaw('textDocument/stall', null)).rejects.toThrow('超时');
  });

  it('dispose 后请求拒绝（服务器不可用）', async () => {
    const client = await createTestClient();
    clients.push(client);
    await client.dispose();
    await expect(client.definition('file:///a.ts', POSITION)).rejects.toThrow();
  });

  it('initialize 幂等：重复调用不重复握手', async () => {
    const client = await createTestClient();
    clients.push(client);
    await client.initialize();
    await expect(client.definition('file:///a.ts', POSITION)).resolves.toHaveLength(1);
  });
});
