// src/main/ipc/handlers/chat.handler.test.ts
// chat.handler 单元测试
// 设计文档 §4.1 分层架构 / §5.1 场景 3（AI 流式对话）
//
// 测试策略：
// 1. mock wrap：捕获注册的 channel + schema + handler，不真实注册 ipcMain.handle
// 2. mock chat.service 的 5 个函数 + agent.service 的 runChatGeneration
// 3. 提取 handler 回调，验证正确调用 service（参数传递 + 返回值）
// 4. sendMessage 测试重点：验证 runChatGeneration 被调用（void 调用不 await）+ ctx.sender 作为 webContents

import { IPC_CHANNELS } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCtx,
  findRegistration,
  type WrapRegistration,
} from '../../__tests__/helpers/mock-wrap';

// vi.hoisted：将 mock 容器提升到文件顶部，避免 vi.mock 工厂内引用触发 TDZ
const {
  registrations,
  mockCreateChatSession,
  mockListChatSessions,
  mockGetChatMessages,
  mockSendChatMessage,
  mockStopChatGeneration,
  mockRunChatGeneration,
} = vi.hoisted(() => ({
  // wrap 注册记录数组（每个 handler 注册时 push 一条）
  registrations: [] as WrapRegistration[],
  // chat.service 5 个函数 mock
  mockCreateChatSession: vi.fn(),
  mockListChatSessions: vi.fn(),
  mockGetChatMessages: vi.fn(),
  mockSendChatMessage: vi.fn(),
  mockStopChatGeneration: vi.fn(),
  // agent.service runChatGeneration mock（后台异步执行，返回 void）
  mockRunChatGeneration: vi.fn().mockResolvedValue(undefined),
}));

// mock wrap：拦截注册调用，记录到 registrations
vi.mock('../../utils/wrap', () => ({
  wrap: (
    channel: string,
    schema: unknown,
    handler: (input: unknown, ctx: unknown) => Promise<unknown>,
  ) => {
    registrations.push({ channel, schema, handler });
  },
}));

// mock chat.service：5 个函数全部替换为 vi.fn
vi.mock('../../services/chat.service', () => ({
  createChatSession: mockCreateChatSession,
  listChatSessions: mockListChatSessions,
  getChatMessages: mockGetChatMessages,
  sendChatMessage: mockSendChatMessage,
  stopChatGeneration: mockStopChatGeneration,
}));

// mock agent.service：runChatGeneration 替换为 vi.fn（resolve undefined）
vi.mock('../../services/agent.service', () => ({
  runChatGeneration: mockRunChatGeneration,
}));

import { registerChatHandlers } from './chat.handler';

describe('chat.handler', () => {
  beforeEach(() => {
    // 重置注册记录 + 清空所有 mock 调用
    registrations.length = 0;
    vi.clearAllMocks();
    // runChatGeneration 默认 resolve undefined（void 调用不抛错）
    mockRunChatGeneration.mockResolvedValue(undefined);
    registerChatHandlers();
  });

  it('应注册 5 个 channel', () => {
    const channels = registrations.map((r) => r.channel);
    expect(channels).toEqual([
      IPC_CHANNELS.CHAT_CREATE_SESSION,
      IPC_CHANNELS.CHAT_LIST_SESSIONS,
      IPC_CHANNELS.CHAT_GET_MESSAGES,
      IPC_CHANNELS.CHAT_SEND_MESSAGE,
      IPC_CHANNELS.CHAT_STOP_GENERATION,
    ]);
  });

  describe('chat:createSession', () => {
    it('应调用 createChatSession 并返回结果', async () => {
      const input = { projectId: 'p1', title: '新书讨论' };
      const expected = {
        id: 's1',
        projectId: 'p1',
        title: '新书讨论',
        context: {},
        model: null,
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      };
      mockCreateChatSession.mockResolvedValue(expected);

      const handler = findRegistration(registrations, IPC_CHANNELS.CHAT_CREATE_SESSION).handler;
      const result = await handler(input, createMockCtx());

      expect(mockCreateChatSession).toHaveBeenCalledWith(input);
      expect(result).toEqual(expected);
    });
  });

  describe('chat:listSessions', () => {
    it('应调用 listChatSessions(projectId) 并返回结果', async () => {
      const expected = [
        {
          id: 's1',
          projectId: 'p1',
          title: '会话1',
          context: {},
          model: null,
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
      ];
      mockListChatSessions.mockResolvedValue(expected);

      const handler = findRegistration(registrations, IPC_CHANNELS.CHAT_LIST_SESSIONS).handler;
      const result = await handler({ projectId: 'p1' }, createMockCtx());

      expect(mockListChatSessions).toHaveBeenCalledWith('p1');
      expect(result).toEqual(expected);
    });
  });

  describe('chat:getMessages', () => {
    it('应调用 getChatMessages(sessionId) 并返回结果', async () => {
      const expected = [
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: '你好',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ];
      mockGetChatMessages.mockResolvedValue(expected);

      const handler = findRegistration(registrations, IPC_CHANNELS.CHAT_GET_MESSAGES).handler;
      const result = await handler({ sessionId: 's1' }, createMockCtx());

      expect(mockGetChatMessages).toHaveBeenCalledWith('s1');
      expect(result).toEqual(expected);
    });
  });

  describe('chat:sendMessage', () => {
    it('应调用 sendChatMessage 持久化消息 + 后台启动 runChatGeneration（传 ctx.sender）+ 返回 ackId', async () => {
      const input = { sessionId: 's1', content: '续写下一章' };
      mockSendChatMessage.mockResolvedValue({ ackId: 'ack-123' });

      const ctx = createMockCtx();
      const handler = findRegistration(registrations, IPC_CHANNELS.CHAT_SEND_MESSAGE).handler;
      const result = await handler(input, ctx);

      // 1. sendChatMessage 被调用（持久化用户消息）
      expect(mockSendChatMessage).toHaveBeenCalledWith(input);

      // 2. runChatGeneration 被调用（后台异步执行，不 await）
      //    入参：sessionId + webContents = ctx.sender
      expect(mockRunChatGeneration).toHaveBeenCalledWith({
        sessionId: 's1',
        webContents: ctx.sender,
      });

      // 3. 立即返回 ackId（不等 AI 生成完成）
      expect(result).toEqual({ ackId: 'ack-123' });
    });

    it('runChatGeneration 抛错时不影响 ackId 返回（void 调用吞掉 rejection）', async () => {
      const input = { sessionId: 's1', content: '续写' };
      mockSendChatMessage.mockResolvedValue({ ackId: 'ack-456' });
      // runChatGeneration reject 也不应影响 handler 返回（void 调用不 await）
      mockRunChatGeneration.mockRejectedValue(new Error('后台生成失败'));

      const handler = findRegistration(registrations, IPC_CHANNELS.CHAT_SEND_MESSAGE).handler;
      const result = await handler(input, createMockCtx());

      expect(result).toEqual({ ackId: 'ack-456' });
      expect(mockRunChatGeneration).toHaveBeenCalled();
    });
  });

  describe('chat:stopGeneration', () => {
    it('应调用 stopChatGeneration(sessionId) 并返回结果', async () => {
      mockStopChatGeneration.mockResolvedValue({ stopped: true });

      const handler = findRegistration(registrations, IPC_CHANNELS.CHAT_STOP_GENERATION).handler;
      const result = await handler({ sessionId: 's1' }, createMockCtx());

      expect(mockStopChatGeneration).toHaveBeenCalledWith('s1');
      expect(result).toEqual({ stopped: true });
    });
  });
});
