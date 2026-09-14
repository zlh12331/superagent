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
type ErrCb = (payload: { sessionId: string; code: string; message: string }) => void;

/** 订阅回调捕获（模拟主进程推送） */
const ipc = vi.hoisted(() => ({
  part: null as PartCb | null,
  end: null as EndCb | null,
  error: null as ErrCb | null,
  runArgs: null as Record<string, unknown> | null,
}));

function stubAgentApi(runResponse: unknown = { data: { sessionId: 's1' } }): void {
  ipc.part = null;
  ipc.end = null;
  ipc.error = null;
  ipc.runArgs = null;
  window.api.agent = {
    run: vi.fn(async (args: Record<string, unknown>) => {
      ipc.runArgs = args;
      return runResponse;
    }),
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
    subscribeStreamError: vi.fn((cb: ErrCb) => {
      ipc.error = cb;
      return () => {
        ipc.error = null;
      };
    }),
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

describe('IpcAgentTransport 配置注入与分支覆盖', () => {
  beforeEach(() => {
    stubAgentApi();
  });

  it('未配置 workingDir 时 sendMessages 直接拒绝（不触碰 IPC）', async () => {
    const transport = new IpcAgentTransport();
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ];
    await expect(
      transport.sendMessages({
        trigger: 'submit-message',
        chatId: 's1',
        messageId: undefined,
        messages,
        abortSignal: undefined,
      }),
    ).rejects.toThrow('workingDir not configured');
    expect(window.api.agent.run).not.toHaveBeenCalled();
  });

  it('configure() 兜底配置 + 增量合并；未命中 chatId 时回落 lastConfig', async () => {
    const transport = new IpcAgentTransport();
    transport.configure({ workingDir: '/a' });
    transport.configureFor('other', { workingDir: '/b', systemPrompt: 'sp' });

    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 'unknown-chat',
      messageId: undefined,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
    });
    await tick();
    expect(window.api.agent.run).toHaveBeenCalledOnce();
    // 未命中 unknown-chat → 回落 lastConfig（configureFor('other') 同步更新为 '/b'）
    expect(ipc.runArgs).toMatchObject({ workingDir: '/b', systemPrompt: 'sp' });
    void stream;
  });

  it('run 入参默认值：maxSteps=20 / mode=build；thinking 透传；temperature 仅在定义时下发', async () => {
    const transport = new IpcAgentTransport();
    transport.configureFor('s1', { workingDir: '/w', thinking: 'high', maxSteps: 5, mode: 'plan' });
    const messages: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] },
    ];
    await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 's1',
      messageId: undefined,
      messages,
      abortSignal: undefined,
    });
    await tick();
    expect(ipc.runArgs).toMatchObject({
      sessionId: 's1',
      workingDir: '/w',
      maxSteps: 5,
      mode: 'plan',
      thinking: 'high',
    });
    expect(ipc.runArgs).not.toHaveProperty('temperature');
  });

  it('temperature 已定义时透传给 run', async () => {
    const transport = new IpcAgentTransport();
    transport.configureFor('s1', { workingDir: '/w', temperature: 0.3 });
    await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 's1',
      messageId: undefined,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
    });
    await tick();
    expect(ipc.runArgs).toMatchObject({ temperature: 0.3 });
  });

  it('stream error 事件 → 流错误 + 三订阅全部退订 + 批处理器释放', async () => {
    const stream = await openStream();
    ipc.error?.({ sessionId: 's1', code: 'AI_TIMEOUT', message: 'boom' });

    await expect(drain(stream)).rejects.toThrow('[AI_TIMEOUT] boom');
    expect(ipc.part).toBeNull();
    expect(ipc.end).toBeNull();
    expect(ipc.error).toBeNull();
  });

  it('其它会话的 error 事件不影响当前流', async () => {
    const stream = await openStream();
    ipc.error?.({ sessionId: 'other', code: 'X', message: 'nope' });
    pushPart({ type: 'text-delta', id: 't1', delta: 'ok' });
    ipc.end?.({ sessionId: 's1' });

    const chunks = await drain(stream);
    expect(chunks).toEqual([{ type: 'text-delta', id: 't1', delta: 'ok' }]);
  });

  it('run 响应携带 error → controller.error + 退订', async () => {
    stubAgentApi({ error: { code: 'E1', message: 'bad request' } });
    const transport = new IpcAgentTransport();
    transport.configureFor('s1', { workingDir: '/w' });
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 's1',
      messageId: undefined,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
    });
    await tick();

    await expect(drain(stream)).rejects.toThrow('[E1] bad request');
    expect(ipc.part).toBeNull();
    expect(ipc.error).toBeNull();
  });

  it('abortSignal 触发 → stop({ sessionId }) 中断主进程', async () => {
    const controller = new AbortController();
    const transport = new IpcAgentTransport();
    transport.configureFor('s1', { workingDir: '/w' });
    await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 's1',
      messageId: undefined,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      abortSignal: controller.signal,
    });
    await tick();
    expect(window.api.agent.stop).not.toHaveBeenCalled();

    controller.abort();
    await tick();
    expect(window.api.agent.stop).toHaveBeenCalledWith({ sessionId: 's1' });
  });

  it('流被消费方取消 → 退订三订阅 + stop 主进程', async () => {
    const stream = await openStream();
    const reader = stream.getReader();
    await reader.cancel();
    await tick();

    expect(window.api.agent.stop).toHaveBeenCalledWith({ sessionId: 's1' });
    expect(ipc.part).toBeNull();
    expect(ipc.end).toBeNull();
    expect(ipc.error).toBeNull();
  });

  it('run 响应 sessionId 与 chatId 不一致 → IPC_CONTRACT 错误 + 退订（契约守卫）', async () => {
    stubAgentApi({ data: { sessionId: 'other-session' } });
    const transport = new IpcAgentTransport();
    transport.configureFor('s1', { workingDir: '/w' });
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 's1',
      messageId: undefined,
      messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
      abortSignal: undefined,
    });
    await tick();

    await expect(drain(stream)).rejects.toThrow('[IPC_CONTRACT]');
    expect(ipc.part).toBeNull();
    expect(ipc.end).toBeNull();
    expect(ipc.error).toBeNull();
  });

  it('run 响应 sessionId 回显一致 → 流正常接收推送', async () => {
    const stream = await openStream();
    pushPart({ type: 'text-delta', id: 't1', delta: 'ok' });
    ipc.end?.({ sessionId: 's1' });
    const chunks = await drain(stream);
    expect(chunks).toEqual([{ type: 'text-delta', id: 't1', delta: 'ok' }]);
  });

  it('reconnectToStream 恒返回 null（主进程不持久化流状态）', async () => {
    const transport = new IpcAgentTransport();
    await expect(transport.reconnectToStream()).resolves.toBeNull();
  });

  // ── 回归：convertToModelMessages 抛错时不得泄漏订阅（P3-41）──────────────
  // 此前该 await 在 try 之外，抛错时 cleanup 永不执行 → 三个 IPC 订阅 + batcher
  // 定时器残留，后续推送会 enqueue 到已 error 的 controller 再抛。
  it('消息转换抛错 → 流错误且三订阅全部退订（不泄漏）', async () => {
    const transport = new IpcAgentTransport();
    transport.configureFor('s1', { workingDir: '/w' });
    const stream = await transport.sendMessages({
      trigger: 'submit-message',
      chatId: 's1',
      messageId: undefined,
      // role 非法：convertToModelMessages 抛 AI_MessageConversionError
      messages: [{ id: 'u1', role: 'bogus', parts: [] }] as unknown as UIMessage[],
      abortSignal: undefined,
    });

    await expect(drain(stream)).rejects.toThrow();
    // 关键断言：订阅已退订 + run 未被调用（转换失败发生在发起之前）
    expect(ipc.part).toBeNull();
    expect(ipc.end).toBeNull();
    expect(ipc.error).toBeNull();
    expect(window.api.agent.run).not.toHaveBeenCalled();
  });
});
