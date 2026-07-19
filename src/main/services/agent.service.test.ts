// src/main/services/agent.service.test.ts
// agent.service 单元测试
// 设计文档 §4.2 agent.service / §5.1 场景 3 / 场景 5

import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock electron app（config/index.ts 依赖 app.isPackaged）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '' },
}));

const {
  mockGetOpenAIClient,
  mockCreate,
  mockStreamBridge,
  mockLogAiUsage,
  mockSearchSimilarChunks,
  mockGetChatMessages,
  mockSaveAssistantMessage,
  mockGetChapter,
  mockCreateChapter,
  mockUpdateChapter,
  mockListChapters,
  mockListCharacters,
  mockChatSession,
  mockProjectSetting,
} = vi.hoisted(() => ({
  // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
  mockGetOpenAIClient: vi.fn(),
  mockCreate: vi.fn(),
  mockStreamBridge: {
    streamToWebContents: vi.fn(),
    has: vi.fn(),
    abort: vi.fn(),
  },
  mockLogAiUsage: vi.fn(),
  mockSearchSimilarChunks: vi.fn(),
  mockGetChatMessages: vi.fn(),
  mockSaveAssistantMessage: vi.fn(),
  mockGetChapter: vi.fn(),
  mockCreateChapter: vi.fn(),
  mockUpdateChapter: vi.fn(),
  mockListChapters: vi.fn(),
  mockListCharacters: vi.fn(),
  mockChatSession: { findUnique: vi.fn() },
  mockProjectSetting: { findUnique: vi.fn() },
}));

vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    chatSession: mockChatSession,
    projectSetting: mockProjectSetting,
  }),
}));

vi.mock('../infra/ai/openai-client', () => ({
  // biome-ignore lint/style/useNamingConvention: 保留 OpenAI 大写以匹配 openai SDK 类名
  getOpenAIClient: mockGetOpenAIClient,
}));

vi.mock('../infra/ai/stream-bridge', () => ({
  getStreamBridge: () => mockStreamBridge,
}));

vi.mock('./ai-usage', () => ({
  logAiUsage: mockLogAiUsage,
}));

vi.mock('./rag.service', () => ({
  searchSimilarChunks: mockSearchSimilarChunks,
}));

vi.mock('./chat.service', () => ({
  getChatMessages: mockGetChatMessages,
  saveAssistantMessage: mockSaveAssistantMessage,
}));

vi.mock('./chapter.service', () => ({
  getChapter: mockGetChapter,
  createChapter: mockCreateChapter,
  updateChapter: mockUpdateChapter,
  listChapters: mockListChapters,
}));

vi.mock('./character.service', () => ({
  listCharacters: mockListCharacters,
}));

import { expandOutline, generateChapter, rewriteChapter, runChatGeneration } from './agent.service';

/** 构造 openai 流式 chunk 的 async generator */
async function* fakeOpenAiStream(chunks: string[]) {
  for (const content of chunks) {
    yield { choices: [{ delta: { content } }] };
  }
}

/** 模拟 webContents（仅类型占位，bridge 被 mock 不会真实调用其方法） */
const fakeWebContents = { isDestroyed: () => false, send: vi.fn() } as never;

describe('agent.service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLogAiUsage.mockResolvedValue(undefined);
    // 默认：openai client 返回流；bridge 消费流并返回拼接文本
    mockGetOpenAIClient.mockResolvedValue({
      chat: { completions: { create: mockCreate } },
    });
    mockStreamBridge.streamToWebContents.mockImplementation(
      async ({ stream }: { stream: AsyncIterable<string> }) => {
        let fullText = '';
        for await (const chunk of stream) {
          fullText += chunk;
        }
        return fullText;
      },
    );
  });

  describe('runChatGeneration', () => {
    it('完整链路：RAG 检索 + 历史 + 流式生成 + 持久化 assistant 消息 + 用量记录', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: '讨论',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.7,
        aiMaxTokens: 4096,
        ragEnabled: true,
        ragTopK: 5,
        ragThreshold: 0.7,
        customPrompts: {},
        updatedAt: new Date(),
      });
      mockSearchSimilarChunks.mockResolvedValue([
        { chunkId: 'c1', documentId: 'd1', content: '主角设定：孤儿', score: 0.9 },
      ]);
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: '续写',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['林', '逸', '睁', '开', '眼']));
      mockSaveAssistantMessage.mockResolvedValue({});

      await runChatGeneration({ sessionId: 's1', webContents: fakeWebContents });

      // RAG 检索
      expect(mockSearchSimilarChunks).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', query: '续写' }),
      );
      // openai 调用：system（含 RAG 片段）+ 历史 user 消息
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'deepseek-v4-flash',
          temperature: 0.7,
          // biome-ignore lint/style/useNamingConvention: max_tokens 是 openai SDK 官方字段名
          max_tokens: 4096,
          stream: true,
        }),
      );
      const [createArgs] = mockCreate.mock.calls[0] as [
        { messages: { role: string; content: string }[] },
      ];
      const messages = createArgs.messages;
      expect(messages[0]?.role).toBe('system');
      expect(messages[0]?.content).toContain('主角设定：孤儿');
      expect(messages[1]).toEqual({ role: 'user', content: '续写' });
      // bridge 推送（sessionId 即流 ID）
      expect(mockStreamBridge.streamToWebContents).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 's1', webContents: fakeWebContents }),
      );
      // assistant 消息持久化
      expect(mockSaveAssistantMessage).toHaveBeenCalledWith('s1', '林逸睁开眼');
      // 用量记录
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', status: 'ok', outputTokens: 5 }),
      );
    });

    it('会话不存在时应记 warn 直接返回（不调用 openai）', async () => {
      mockChatSession.findUnique.mockResolvedValue(null);

      await runChatGeneration({ sessionId: 'nope', webContents: fakeWebContents });

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('ragEnabled=false 时应跳过 RAG 检索', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue({
        projectId: 'p1',
        aiModel: 'deepseek-v4-flash',
        aiTemperature: 0.7,
        aiMaxTokens: 4096,
        ragEnabled: false,
        ragTopK: 5,
        ragThreshold: 0.7,
        customPrompts: {},
        updatedAt: new Date(),
      });
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'hi',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['ok']));
      mockSaveAssistantMessage.mockResolvedValue({});

      await runChatGeneration({ sessionId: 's1', webContents: fakeWebContents });

      expect(mockSearchSimilarChunks).not.toHaveBeenCalled();
    });

    it('RAG 检索失败应降级为无 RAG 继续生成（仅 warn）', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue(null); // 无设置 → 默认 ragEnabled=true
      mockSearchSimilarChunks.mockRejectedValue(new Error('ollama down'));
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'hi',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['ok']));
      mockSaveAssistantMessage.mockResolvedValue({});

      await runChatGeneration({ sessionId: 's1', webContents: fakeWebContents });

      // 即使 RAG 失败，生成仍继续
      expect(mockCreate).toHaveBeenCalled();
      expect(mockSaveAssistantMessage).toHaveBeenCalledWith('s1', 'ok');
    });

    it('openai 流异常应记录 error 用量（不 rethrow）', async () => {
      mockChatSession.findUnique.mockResolvedValue({
        id: 's1',
        projectId: 'p1',
        title: 'T',
        context: {},
        model: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockGetChatMessages.mockResolvedValue([
        {
          id: 'm1',
          sessionId: 's1',
          role: 'user',
          content: 'hi',
          tokens: 2,
          metadata: {},
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockSearchSimilarChunks.mockResolvedValue([]);
      mockCreate.mockRejectedValue(new Error('HTTP 429'));

      await expect(
        runChatGeneration({ sessionId: 's1', webContents: fakeWebContents }),
      ).resolves.toBeUndefined();

      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', status: 'error', error: 'HTTP 429' }),
      );
      expect(mockSaveAssistantMessage).not.toHaveBeenCalled();
    });
  });

  describe('generateChapter', () => {
    it('应立即返回 ackId，后台完成：前文+人物+RAG → 流式 → 自动建章', async () => {
      mockGetChapter.mockResolvedValue({
        id: 'ch1',
        projectId: 'p1',
        volumeId: null,
        title: '第一章',
        content: '前文内容',
        wordCount: 4,
        status: 'COMPLETED',
        sortOrder: 0,
        metadata: {},
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
      mockListChapters.mockResolvedValue([{ id: 'ch1' }]);
      mockListCharacters.mockResolvedValue([
        {
          id: 'c1',
          projectId: 'p1',
          name: '林逸',
          avatar: null,
          role: 'PROTAGONIST',
          description: '主角',
          profile: {},
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: '2026-07-19T00:00:00.000Z',
        },
      ]);
      mockSearchSimilarChunks.mockResolvedValue([
        { chunkId: 'k1', documentId: 'd1', content: '世界观：灵气复苏', score: 0.88 },
      ]);
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['新章', '内容']));
      mockCreateChapter.mockResolvedValue({});

      const result = await generateChapter({
        projectId: 'p1',
        prevChapterId: 'ch1',
        webContents: fakeWebContents,
      });

      // 立即返回 ackId（36 位 UUID）
      expect(result.ackId).toHaveLength(36);

      // 等待后台 Promise 完成（ackId 返回后生成仍在进行，这里等微任务+宏任务冲刷）
      await vi.waitFor(() => {
        expect(mockCreateChapter).toHaveBeenCalled();
      });

      // prompt 中应包含前文 / 人物 / RAG 片段
      const [createArgs] = mockCreate.mock.calls[0] as [
        { messages: { role: string; content: string }[] },
      ];
      const messages = createArgs.messages;
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userPrompt).toContain('前文内容');
      expect(userPrompt).toContain('林逸');
      expect(userPrompt).toContain('世界观：灵气复苏');

      // 自动创建章节（标题 = 第2章）
      expect(mockCreateChapter).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p1', title: '第2章', content: '新章内容' }),
      );
      // 用量记录
      expect(mockLogAiUsage).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'deepseek', status: 'ok' }),
      );
    });

    it('prevChapterId 未传时应跳过前文获取', async () => {
      mockListChapters.mockResolvedValue([]);
      mockListCharacters.mockResolvedValue([]);
      mockSearchSimilarChunks.mockResolvedValue([]);
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['x']));
      mockCreateChapter.mockResolvedValue({});

      const result = await generateChapter({ projectId: 'p1', webContents: fakeWebContents });

      expect(result.ackId).toHaveLength(36);
      await vi.waitFor(() => {
        expect(mockCreateChapter).toHaveBeenCalled();
      });
      expect(mockGetChapter).not.toHaveBeenCalled();
      expect(mockCreateChapter).toHaveBeenCalledWith(expect.objectContaining({ title: '第1章' }));
    });
  });

  describe('rewriteChapter', () => {
    it('应取原文 → 改写 prompt → 流式 → 更新章节内容', async () => {
      mockGetChapter.mockResolvedValue({
        id: 'ch1',
        projectId: 'p1',
        volumeId: null,
        title: '第一章',
        content: '原始内容',
        wordCount: 4,
        status: 'DRAFT',
        sortOrder: 0,
        metadata: {},
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T00:00:00.000Z',
      });
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['改写后']));
      mockUpdateChapter.mockResolvedValue({});

      const result = await rewriteChapter({
        chapterId: 'ch1',
        instruction: '加强打斗描写',
        webContents: fakeWebContents,
      });

      expect(result.ackId).toHaveLength(36);
      await vi.waitFor(() => {
        expect(mockUpdateChapter).toHaveBeenCalled();
      });

      const [createArgs] = mockCreate.mock.calls[0] as [
        { messages: { role: string; content: string }[] },
      ];
      const messages = createArgs.messages;
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userPrompt).toContain('原始内容');
      expect(userPrompt).toContain('加强打斗描写');
      expect(mockUpdateChapter).toHaveBeenCalledWith({ id: 'ch1', content: '改写后' });
    });
  });

  describe('expandOutline', () => {
    it('应流式扩写大纲（不持久化任何内容）', async () => {
      mockProjectSetting.findUnique.mockResolvedValue(null);
      mockCreate.mockResolvedValue(fakeOpenAiStream(['详细', '大纲']));

      const result = await expandOutline({
        projectId: 'p1',
        outline: '主角下山历练',
        webContents: fakeWebContents,
      });

      expect(result.ackId).toHaveLength(36);
      await vi.waitFor(() => {
        expect(mockLogAiUsage).toHaveBeenCalledWith(expect.objectContaining({ status: 'ok' }));
      });

      const [createArgs] = mockCreate.mock.calls[0] as [
        { messages: { role: string; content: string }[] },
      ];
      const messages = createArgs.messages;
      const userPrompt = messages.find((m) => m.role === 'user')?.content ?? '';
      expect(userPrompt).toContain('主角下山历练');
      // 不持久化
      expect(mockCreateChapter).not.toHaveBeenCalled();
      expect(mockUpdateChapter).not.toHaveBeenCalled();
      expect(mockSaveAssistantMessage).not.toHaveBeenCalled();
    });
  });
});
