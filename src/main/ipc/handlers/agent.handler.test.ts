// src/main/ipc/handlers/agent.handler.test.ts
// agent.handler 单元测试
// 设计文档 §4.1 分层架构 / §5.1 场景 5（Agent 章节生成）
//
// 测试策略：
// 1. mock wrap：捕获注册的 channel + schema + handler
// 2. mock agent.service 的 3 个函数（generateChapter / rewriteChapter / expandOutline）
// 3. 验证 handler 调用 service 时传入了 webContents（ctx.sender）
// 4. 验证返回 { ackId } 结构

import { IPC_CHANNELS } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMockCtx,
  findRegistration,
  type WrapRegistration,
} from '../../__tests__/helpers/mock-wrap';

// vi.hoisted：将 mock 容器提升到文件顶部，避免 vi.mock 工厂内引用触发 TDZ
const { registrations, mockGenerateChapter, mockRewriteChapter, mockExpandOutline } = vi.hoisted(
  () => ({
    // wrap 注册记录数组
    registrations: [] as WrapRegistration[],
    // agent.service 3 个函数 mock，统一返回 { ackId: 'test-ack' }
    mockGenerateChapter: vi.fn().mockResolvedValue({ ackId: 'test-ack' }),
    mockRewriteChapter: vi.fn().mockResolvedValue({ ackId: 'test-ack' }),
    mockExpandOutline: vi.fn().mockResolvedValue({ ackId: 'test-ack' }),
  }),
);

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

// mock agent.service：3 个函数全部替换为 vi.fn
vi.mock('../../services/agent.service', () => ({
  generateChapter: mockGenerateChapter,
  rewriteChapter: mockRewriteChapter,
  expandOutline: mockExpandOutline,
}));

import { registerAgentHandlers } from './agent.handler';

describe('agent.handler', () => {
  beforeEach(() => {
    registrations.length = 0;
    vi.clearAllMocks();
    // 默认返回 { ackId: 'test-ack' }
    mockGenerateChapter.mockResolvedValue({ ackId: 'test-ack' });
    mockRewriteChapter.mockResolvedValue({ ackId: 'test-ack' });
    mockExpandOutline.mockResolvedValue({ ackId: 'test-ack' });
    registerAgentHandlers();
  });

  it('应注册 3 个 channel', () => {
    const channels = registrations.map((r) => r.channel);
    expect(channels).toEqual([
      IPC_CHANNELS.AGENT_GENERATE_CHAPTER,
      IPC_CHANNELS.AGENT_REWRITE,
      IPC_CHANNELS.AGENT_EXPAND_OUTLINE,
    ]);
  });

  describe('agent:generateChapter', () => {
    it('应调用 generateChapter 并传入 webContents（ctx.sender）+ 返回 ackId', async () => {
      const input = { projectId: 'p1', prevChapterId: 'c1', prompt: '加入战斗场景' };
      const ctx = createMockCtx();

      const handler = findRegistration(registrations, IPC_CHANNELS.AGENT_GENERATE_CHAPTER).handler;
      const result = await handler(input, ctx);

      // 验证 service 被调用，入参为 input 展开 + webContents
      expect(mockGenerateChapter).toHaveBeenCalledWith({
        ...input,
        webContents: ctx.sender,
      });
      expect(result).toEqual({ ackId: 'test-ack' });
    });

    it('prevChapterId / prompt 可选时也能正确调用', async () => {
      const input = { projectId: 'p1' };
      const ctx = createMockCtx();

      const handler = findRegistration(registrations, IPC_CHANNELS.AGENT_GENERATE_CHAPTER).handler;
      const result = await handler(input, ctx);

      expect(mockGenerateChapter).toHaveBeenCalledWith({
        projectId: 'p1',
        webContents: ctx.sender,
      });
      expect(result).toEqual({ ackId: 'test-ack' });
    });
  });

  describe('agent:rewrite', () => {
    it('应调用 rewriteChapter 并传入 webContents（ctx.sender）+ 返回 ackId', async () => {
      const input = { chapterId: 'c1', instruction: '把开头改得更紧凑' };
      const ctx = createMockCtx();

      const handler = findRegistration(registrations, IPC_CHANNELS.AGENT_REWRITE).handler;
      const result = await handler(input, ctx);

      expect(mockRewriteChapter).toHaveBeenCalledWith({
        ...input,
        webContents: ctx.sender,
      });
      expect(result).toEqual({ ackId: 'test-ack' });
    });
  });

  describe('agent:expandOutline', () => {
    it('应调用 expandOutline 并传入 webContents（ctx.sender）+ 返回 ackId', async () => {
      const input = { projectId: 'p1', outline: '主角林逸从孤儿成长为剑客' };
      const ctx = createMockCtx();

      const handler = findRegistration(registrations, IPC_CHANNELS.AGENT_EXPAND_OUTLINE).handler;
      const result = await handler(input, ctx);

      expect(mockExpandOutline).toHaveBeenCalledWith({
        ...input,
        webContents: ctx.sender,
      });
      expect(result).toEqual({ ackId: 'test-ack' });
    });
  });
});
