// src/main/infra/lsp/lsp-client-gaps.test.ts
// lsp-client 缺口补全：配置缺省 / 生命周期事件 / hover 形状归一化 / 协议解析边界
//
// 测试要点：
// 1. 构造：args/timeoutMs 缺省回退
// 2. initialize：已释放抛错 / 未初始化请求抛错
// 3. exit/error 事件：服务器退出拒绝未决请求
// 4. hover：非对象 / 数组混合 / 单对象 value / 非法形状 → null
// 5. drainFrames：头损坏丢弃 / 帧未收全等待
// 6. dispatchFrame：错误响应 reject / 服务器通知记录 / 未知 id 忽略

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LspClient, type LspPosition } from './lsp-client';

const mocks = vi.hoisted(() => {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return { mockLogger };
});

// 注意：lsp-client 在 infra/lsp/ 下，logger 相对路径为 '../../utils/logger'
vi.mock('../../utils/logger', () => ({
  logger: mocks.mockLogger,
}));

/** 简易 fake 语言服务器（支持 initialize/hover/stall/通知/错误响应） */
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
    case 'textDocument/hover':
      // 返回数组混合形状（string + {value} + 非法）
      send({ jsonrpc: '2.0', id: msg.id, result: { contents: ['第一段', { value: '第二段' }, 42], range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } });
      break;
    case 'textDocument/stall':
      break;
    case 'textDocument/errorResp':
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });
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

/** 启动 fake 服务器并创建客户端 */
async function createTestClient(
  config?: Partial<ConstructorParameters<typeof LspClient>[0]>,
): Promise<LspClient> {
  const client = new LspClient({
    command: process.execPath,
    args: ['-e', FAKE_SERVER_SCRIPT],
    rootUri: 'file:///proj',
    timeoutMs: 2_000,
    ...config,
  });
  await client.initialize();
  return client;
}

const POSITION: LspPosition = { line: 0, character: 0 };

describe('LspClient 批次11 缺口补全', () => {
  const clients: LspClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      await client.dispose().catch(() => {});
    }
    clients.length = 0;
  });

  it('构造缺省：args 为空数组、timeoutMs 回退 15000', () => {
    const client = new LspClient({
      command: 'node',
      rootUri: 'file:///proj',
    });
    const internals = client as unknown as { args: string[]; timeoutMs: number };
    expect(internals.args).toEqual([]);
    expect(internals.timeoutMs).toBe(15_000);
  });

  it('initialize 已释放：抛错', async () => {
    const client = await createTestClient();
    clients.push(client);
    await client.dispose();
    await expect(client.initialize()).rejects.toThrow('已释放');
  });

  it('未初始化请求：ensureReady 抛错', async () => {
    const client = new LspClient({
      command: process.execPath,
      args: ['-e', FAKE_SERVER_SCRIPT],
      rootUri: 'file:///proj',
      timeoutMs: 2_000,
    });
    await expect(client.definition('file:///a.ts', POSITION)).rejects.toThrow('未初始化');
  });

  it('hover 数组混合形状：string + {value} 拼接，非法项过滤', async () => {
    const client = await createTestClient();
    clients.push(client);
    const hover = await client.hover('file:///a.ts', POSITION);
    expect(hover?.contents).toBe('第一段\n第二段');
    expect(hover?.range).toBeDefined();
  });

  it('hover 结果非对象（null）：返回 null', async () => {
    // 独立 fake server：hover 返回 result=null（非对象形状）
    const nullHoverScript = `
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
  if (msg.method === 'textDocument/hover') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null });
    return;
  }
  send({ jsonrpc: '2.0', id: msg.id, result: null });
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
    const client = new LspClient({
      command: process.execPath,
      args: ['-e', nullHoverScript],
      rootUri: 'file:///proj',
      timeoutMs: 2_000,
    });
    clients.push(client);
    await client.initialize();
    const result = await client.hover('file:///a.ts', POSITION);
    expect(result).toBeNull();
  });

  it('服务器退出（exit 事件）：拒绝全部未决请求', async () => {
    const client = await createTestClient();
    clients.push(client);
    // 发送 stall 请求（永不响应），随后杀死服务器 → exit 事件拒绝未决
    const requestPromise = client.requestRaw('textDocument/stall', null);
    const child = (client as unknown as { child: { kill: () => void } }).child;
    child.kill();
    await expect(requestPromise).rejects.toThrow('服务器退出');
  });

  it('spawn 失败（error 事件）：拒绝未决请求', async () => {
    const client = new LspClient({
      command: 'nonexistent-command-xyz',
      args: [],
      rootUri: 'file:///proj',
      timeoutMs: 2_000,
    });
    await expect(client.initialize()).rejects.toThrow('服务器启动失败');
  });

  it('错误响应（JSON-RPC error）：reject 带错误码', async () => {
    const client = await createTestClient();
    clients.push(client);
    await expect(client.requestRaw('textDocument/errorResp', null)).rejects.toThrow(
      /请求错误（-32601）/,
    );
  });

  it('协议解析：头损坏丢弃 + 帧未收全等待（drainFrames 边界）', () => {
    const client = new LspClient({
      command: process.execPath,
      rootUri: 'file:///proj',
      timeoutMs: 2_000,
    });
    const internals = client as unknown as {
      readBuffer: Buffer;
      drainFrames: () => void;
      loggerTag: string;
    };
    // 头损坏：无 Content-Length 的帧头 → 丢弃并继续
    internals.readBuffer = Buffer.from('BROKEN-HEADER\r\n\r\nrest');
    internals.drainFrames();
    expect(internals.readBuffer.toString('utf8')).toBe('rest');
    // 帧未收全：合法头但 body 不足 → 等待
    internals.readBuffer = Buffer.from('Content-Length: 100\r\n\r\nshort');
    internals.drainFrames();
    expect(internals.readBuffer.toString('utf8')).toBe('Content-Length: 100\r\n\r\nshort');
  });

  it('服务器通知（无 id 帧）：记录日志不抛', () => {
    const client = new LspClient({
      command: process.execPath,
      rootUri: 'file:///proj',
      timeoutMs: 2_000,
    });
    const internals = client as unknown as {
      readBuffer: Buffer;
      drainFrames: () => void;
      loggerTag: string;
    };
    const notification = JSON.stringify({
      jsonrpc: '2.0',
      method: 'window/logMessage',
      params: {},
    });
    internals.readBuffer = Buffer.from(
      `Content-Length: ${Buffer.byteLength(notification)}\r\n\r\n${notification}`,
    );
    internals.drainFrames();
    expect(mocks.mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'window/logMessage' }),
      'LSP 通知',
    );
  });

  it('未知 id 响应：忽略', () => {
    const client = new LspClient({
      command: process.execPath,
      rootUri: 'file:///proj',
      timeoutMs: 2_000,
    });
    const internals = client as unknown as {
      readBuffer: Buffer;
      drainFrames: () => void;
      loggerTag: string;
    };
    const response = JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} });
    internals.readBuffer = Buffer.from(
      `Content-Length: ${Buffer.byteLength(response)}\r\n\r\n${response}`,
    );
    expect(() => internals.drainFrames()).not.toThrow();
  });
});
