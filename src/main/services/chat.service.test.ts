// src/main/services/chat.service.test.ts
// chat.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ChatSession / ChatMessage 模型

import { ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

const { mockChatSession, mockChatMessage, mockStreamBridge } = vi.hoisted(() => ({
  mockChatSession: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
  },
  mockChatMessage: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
  mockStreamBridge: {
    has: vi.fn(),
    abort: vi.fn(),
  },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    chatSession: mockChatSession,
    chatMessage: mockChatMessage,
  }),
}));

vi.mock('../infra/ai/stream-bridge', () => ({
  getStreamBridge: () => mockStreamBridge,
}));

import {
  createChatSession,
  deleteChatSession,
  getChatMessages,
  listChatSessions,
  saveAssistantMessage,
  sendChatMessage,
  stopChatGeneration,
} from './chat.service';

describe('chat.service', () => {
  beforeEach(() => {
    resetMocks();
    mockChatSession.findUnique.mockReset();
    mockChatSession.findMany.mockReset();
    mockChatSession.create.mockReset();
    mockChatSession.delete.mockReset();
    mockChatMessage.findMany.mockReset();
    mockChatMessage.create.mockReset();
    mockStreamBridge.has.mockReset();
    mockStreamBridge.abort.mockReset();
  });

  describe('createChatSession', () => {
    it('应创建对话会话', async () => {
      const now = new Date();
      mockChatSession.create.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: '新书讨论',
        context: {},
        model: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = await createChatSession({
        projectId: 'p1',
        title: '新书讨论',
      });

      expect(mockChatSession.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          title: '新书讨论',
          model: undefined,
          context: {},
        },
      });
      expect(result.id).toBe('s1');
    });
  });

  describe('listChatSessions', () => {
    it('应返回会话列表（按 updatedAt 倒序）', async () => {
      const now = new Date();
      mockChatSession.findMany.mockResolvedValue([
        {
          id: 's1',
          projectId: 'p1',
          title: 'A',
          context: {},
          model: null,
          createdAt: now,
          updatedAt: now,
        },
      ]);

      const result = await listChatSessions('p1');

      expect(mockChatSession.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { updatedAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('getChatMessages', () => {
    it('应返回消息列表（按 createdAt 升序）', async () => {
      const now = new Date();
      mockChatMessage.findMany.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: '你好',
          tokens: 2,
          metadata: {},
          createdAt: now,
        },
      ]);

      const result = await getChatMessages('s1');

      expect(mockChatMessage.findMany).toHaveBeenCalledWith({
        where: { sessionId: 's1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.role).toBe('user');
    });
  });

  describe('sendChatMessage', () => {
    it('应持久化用户消息并返回 ackId', async () => {
      const now = new Date();
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: now,
        updatedAt: now,
      });
      mockChatMessage.create.mockResolvedValue({});

      const result = await sendChatMessage({ sessionId: 's1', content: '续写下一章' });

      // tokens 用 content.length 估算（'续写下一章' 共 5 个中文字符）
      expect(mockChatMessage.create).toHaveBeenCalledWith({
        data: {
          sessionId: 's1',
          role: 'user',
          content: '续写下一章',
          tokens: 5,
          metadata: {},
        },
      });
      expect(result.ackId).toEqual(expect.any(String));
      expect(result.ackId).toHaveLength(36); // UUID v4 长度
    });

    it('会话不存在应抛 NOT_FOUND', async () => {
      mockChatSession.findUnique.mockResolvedValue(null);
      await expect(sendChatMessage({ sessionId: 'nope', content: 'x' })).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('stopChatGeneration', () => {
    it('有活跃流时应调用 abort 并返回 stopped=true', async () => {
      mockStreamBridge.has.mockReturnValue(true);

      const result = await stopChatGeneration('s1');

      expect(mockStreamBridge.has).toHaveBeenCalledWith('s1');
      expect(mockStreamBridge.abort).toHaveBeenCalledWith('s1');
      expect(result).toEqual({ stopped: true });
    });

    it('无活跃流时应返回 stopped=false（不调用 abort）', async () => {
      mockStreamBridge.has.mockReturnValue(false);

      const result = await stopChatGeneration('s1');

      expect(mockStreamBridge.abort).not.toHaveBeenCalled();
      expect(result).toEqual({ stopped: false });
    });
  });

  describe('deleteChatSession', () => {
    const now = new Date();

    it('应删除会话并返回 id（无活跃流时不调用 abort）', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: now,
        updatedAt: now,
      });
      mockStreamBridge.has.mockReturnValue(false);
      mockChatSession.delete.mockResolvedValue({});

      const result = await deleteChatSession('s1');

      expect(mockChatSession.findUnique).toHaveBeenCalledWith({ where: { id: 's1' } });
      expect(mockStreamBridge.has).toHaveBeenCalledWith('s1');
      // 无活跃流，不调用 abort
      expect(mockStreamBridge.abort).not.toHaveBeenCalled();
      // 调用 prisma.chatSession.delete 级联删除消息（onDelete: Cascade）
      expect(mockChatSession.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
      expect(result).toEqual({ id: 's1' });
    });

    it('有活跃 AI 流时应先 abort 再删除', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: now,
        updatedAt: now,
      });
      mockStreamBridge.has.mockReturnValue(true);
      mockChatSession.delete.mockResolvedValue({});

      await deleteChatSession('s1');

      // 验证 abort 在 delete 之前被调用（避免删除后流仍尝试写消息）
      expect(mockStreamBridge.abort).toHaveBeenCalledWith('s1');
      expect(mockChatSession.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    });

    it('会话不存在应抛 NOT_FOUND', async () => {
      mockChatSession.findUnique.mockResolvedValue(null);

      await expect(deleteChatSession('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
      // 不应调用 delete 或 abort
      expect(mockChatSession.delete).not.toHaveBeenCalled();
      expect(mockStreamBridge.abort).not.toHaveBeenCalled();
    });
  });

  describe('saveAssistantMessage', () => {
    it('应持久化 assistant 消息（tokens 按 content.length 估算）', async () => {
      const now = new Date();
      mockChatMessage.create.mockResolvedValue({
        id: 'm2',
        sessionId: 's1',
        role: 'assistant',
        content: 'AI 回复内容',
        tokens: 7,
        metadata: {},
        createdAt: now,
      });

      const result = await saveAssistantMessage('s1', 'AI 回复内容');

      expect(mockChatMessage.create).toHaveBeenCalledWith({
        data: {
          sessionId: 's1',
          role: 'assistant',
          content: 'AI 回复内容',
          tokens: 7, // 'AI 回复内容'.length === 7
          metadata: {},
        },
      });
      expect(result.role).toBe('assistant');
      expect(result.createdAt).toBe(now.toISOString());
    });
  });
});
