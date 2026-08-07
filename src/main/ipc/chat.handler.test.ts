// src/main/ipc/chat.handler.test.ts
// chat.handler 单测：send/stop（fake ChatService DI 注入）

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type ChatHandlerDeps, createChatHandlers } from './chat.handler';

/** 创建 fake ChatService */
function createFakeChatService() {
  return {
    startChat: vi.fn(async () => 'chat-abc'),
    abort: vi.fn(() => true),
    abortAll: vi.fn(),
    dispose: vi.fn(async () => {}),
  } as unknown as ChatHandlerDeps['chatService'];
}

function createCtx() {
  return { sender: { id: 1 }, traceId: 'trace-1' } as never;
}

describe('chat.handler', () => {
  let chatService: ReturnType<typeof createFakeChatService>;
  let handlers: ReturnType<typeof createChatHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    chatService = createFakeChatService();
    handlers = createChatHandlers({ chatService });
  });

  it('send：转发消息与 sender 并返回 sessionId', async () => {
    const result = await handlers.send(
      {
        messages: [{ role: 'user', content: 'hi' }],
        sessionId: undefined,
        thinking: undefined,
      },
      createCtx(),
    );
    expect(chatService.startChat).toHaveBeenCalledWith({
      messages: [{ role: 'user', content: 'hi' }],
      sessionId: undefined,
      webContents: { id: 1 },
    });
    expect(result.sessionId).toBe('chat-abc');
  });

  it('stop：调用 abort 并返回结果', async () => {
    const result = await handlers.stop({ sessionId: 'chat-x' }, {} as never);
    expect(chatService.abort).toHaveBeenCalledWith('chat-x');
    expect(result.stopped).toBe(true);
  });
});
