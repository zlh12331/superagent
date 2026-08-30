// src/renderer/lib/agent/ipc-agent-transport.test.ts
// IpcAgentTransport 流式出口批处理回归
// ──────────────────────────────────────────────
// 锁定缺陷「每个 token 一次 stream 提交 ⇒ 流式消息 react-markdown 全量重解析 O(n²)」：
// IPC 侧推 500 条 text-delta，出口只允许少量提交，且合并后文本逐字符无损。

import type { UIMessage, UIMessageChunk } from 'ai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IpcAgentTransport } from './ipc-agent-transport';

type PartCb = (payload: { sessionId: string; part: unknown }) => void;
type EndCb = (payload: { sessionId: string }) => void;

/** 订阅回调捕获（模拟主进程推送） */
const ipc = vi.hoisted(() => ({
  part: null as PartCb | null,
  end: null as EndCb | null,
}));

function stubAgentApi(): void {
  ipc.part = null;
  ipc.end = null;
  window.api.agent = {
    run: vi.fn(async () => ({ data: { ok: true } })),
    stop: vi.fn(async () => ({ data: { ok: true } })),
    subscribeStreamPart: vi.fn((cb: PartCb) => {
      ipc.part = cb;
      return () => {
        ipc.part = null;
      };
    }),
    subscribeStreamEnd: vi.fn((cb: EndCb) => {
      ipc.end = cb;
      return () => {
        ipc.end = null;
      };
    }),
    subscribeStreamError: vi.fn(() => () => {}),
  } as never;
}

/** 让 transport.start() 内部的 await（订阅 + run）完成 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function pushPart(part: unknown, sessionId = 's1'): void {
  ipc.part?.({ sessionId, part });
}

async function drain(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return chunks;
}

async function openStream(): Promise<ReadableStream<UIMessageChunk>> {
  const transport = new IpcAgentTransport();
  transport.configureFor('s1', { workingDir: '/w' });
  const messages: UIMessage[] = [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }];
  const stream = await transport.sendMessages({
    trigger: 'submit-message',
    chatId: 's1',
    messageId: undefined,
    messages,
    abortSignal: undefined,
  });
  await tick();
  return stream;
}

describe('IpcAgentTransport 流式出口批处理', () => {
  beforeEach(() => {
    stubAgentApi();
  });

  it('500 条 text-delta 推送不再产生 500 次 stream 提交', async () => {
    const stream = await openStream();
    const expected = Array.from({ length: 500 }, (_, i) => `w${i}`).join('');

    pushPart({ type: 'text-start', id: 't1' });
    for (const word of Array.from({ length: 500 }, (_, i) => `w${i}`)) {
      pushPart({ type: 'text-delta', id: 't1', delta: word });
    }
    pushPart({ type: 'text-end', id: 't1' });
    ipc.end?.({ sessionId: 's1' });

    const chunks = await drain(stream);
    // text-start + 合并后的 text-delta + text-end（窗口定时器可能再切几刀，但必须远小于 token 数）
    expect(chunks.length).toBeLessThan(20);
    const merged = chunks
      .filter((c) => c.type === 'text-delta')
      .map((c) => (c.type === 'text-delta' ? c.delta : ''))
      .join('');
    expect(merged).toBe(expected);
  });

  it('end 事件前缓冲文本必须落地（末段 token 不丢）', async () => {
    const stream = await openStream();
    pushPart({ type: 'text-delta', id: 't1', delta: 'tail' });
    ipc.end?.({ sessionId: 's1' });

    const chunks = await drain(stream);
    expect(chunks).toEqual([{ type: 'text-delta', id: 't1', delta: 'tail' }]);
  });

  it('其它会话的事件不进当前流（sessionId 过滤仍生效）', async () => {
    const stream = await openStream();
    pushPart({ type: 'text-delta', id: 't1', delta: 'nope' }, 'other-session');
    ipc.end?.({ sessionId: 's1' });

    const chunks = await drain(stream);
    expect(chunks).toEqual([]);
  });
});
