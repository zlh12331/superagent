// src/main/services/chapter.service.test.ts
// chapter.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Chapter 模型

import { ChapterStatus, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 db-init.test.ts）
// mockChapter 仅含 service 实际调用的 5 个方法；mockTransaction 透传 $transaction 数组形式
const { mockChapter, mockTransaction } = vi.hoisted(() => ({
  mockChapter: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockTransaction: vi.fn(),
}));

// mock PrismaClient 单例模块
// 使用 spread + 覆盖 chapter，避免修改共享的 mockPrismaClient；同时注入 $transaction
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    chapter: mockChapter,
    $transaction: mockTransaction,
  }),
}));

// 直接 import（vi.mock 已提升）
import {
  createChapter,
  deleteChapter,
  getChapter,
  listChapters,
  reorderChapters,
  updateChapter,
} from './chapter.service';

describe('chapter.service', () => {
  beforeEach(() => {
    // resetMocks 重置共享 mockPrismaClient 中所有 model（保持完整 9 方法）
    // mockChapter / mockTransaction 是局部 mock，需单独 reset
    resetMocks();
    mockChapter.findUnique.mockReset();
    mockChapter.findMany.mockReset();
    mockChapter.create.mockReset();
    mockChapter.update.mockReset();
    mockChapter.delete.mockReset();
    mockTransaction.mockReset();
  });

  describe('createChapter', () => {
    it('应创建章节并自动计算 wordCount', async () => {
      // ChapterCreateInput 经 Zod parse 后 status / sortOrder 必填（.default() 填充）
      // 测试直接构造完整入参，绕过 IPC 层 Zod parse
      const input = {
        projectId: 'p1',
        title: '第一章',
        content: '这是正文内容，共 12 字。',
        status: ChapterStatus.DRAFT,
        sortOrder: 0,
      };
      const now = new Date();
      // wordCount 用 content.length 估算（'这是正文内容，共 12 字。' 共 14 个字符）
      mockChapter.create.mockResolvedValue({
        ...sampleDbChapter('c1', now),
        ...input,
        wordCount: 14,
      });

      const result = await createChapter(input);

      expect(mockChapter.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          volumeId: undefined,
          title: '第一章',
          content: '这是正文内容，共 12 字。',
          status: 'DRAFT',
          sortOrder: 0,
          wordCount: 14,
          metadata: {},
        },
      });
      expect(result.id).toBe('c1');
      expect(result.wordCount).toBe(14);
    });

    it('传入 volumeId 时应正确关联', async () => {
      const now = new Date();
      mockChapter.create.mockResolvedValue({
        ...sampleDbChapter('c1', now),
        projectId: 'p1',
        volumeId: 'v1',
        title: 'T',
        content: '',
        wordCount: 0,
      });

      await createChapter({
        projectId: 'p1',
        volumeId: 'v1',
        title: 'T',
        content: '',
        status: ChapterStatus.DRAFT,
        sortOrder: 0,
      });

      expect(mockChapter.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ volumeId: 'v1' }),
      });
    });
  });

  describe('listChapters', () => {
    it('应返回章节列表（按 sortOrder 升序）', async () => {
      const now = new Date();
      mockChapter.findMany.mockResolvedValue([
        { ...sampleDbChapter('c1', now), projectId: 'p1', sortOrder: 0 },
        { ...sampleDbChapter('c2', now), projectId: 'p1', sortOrder: 1 },
      ]);

      const result = await listChapters('p1');

      expect(mockChapter.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('getChapter', () => {
    it('应返回单个章节', async () => {
      const now = new Date();
      mockChapter.findUnique.mockResolvedValue(sampleDbChapter('c1', now));

      const result = await getChapter('c1');

      expect(mockChapter.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(result.id).toBe('c1');
    });

    it('章节不存在应抛 CHAPTER_NOT_FOUND', async () => {
      mockChapter.findUnique.mockResolvedValue(null);
      await expect(getChapter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHAPTER_NOT_FOUND,
      });
    });
  });

  describe('updateChapter', () => {
    it('应更新 content 时自动重算 wordCount', async () => {
      const now = new Date();
      // wordCount 用 content.length 估算（'新内容 4 字' 共 7 个字符）
      mockChapter.findUnique.mockResolvedValue(sampleDbChapter('c1', now));
      mockChapter.update.mockResolvedValue({
        ...sampleDbChapter('c1', now),
        content: '新内容 4 字',
        wordCount: 7,
      });

      const result = await updateChapter({ id: 'c1', content: '新内容 4 字' });

      expect(mockChapter.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { content: '新内容 4 字', wordCount: 7 },
      });
      expect(result.wordCount).toBe(7);
    });

    it('章节不存在应抛 CHAPTER_NOT_FOUND', async () => {
      mockChapter.findUnique.mockResolvedValue(null);
      await expect(updateChapter({ id: 'nope', title: 'x' })).rejects.toMatchObject({
        code: ErrorCode.CHAPTER_NOT_FOUND,
      });
    });
  });

  describe('reorderChapters', () => {
    it('应批量更新 sortOrder（事务原子性）', async () => {
      // $transaction 数组形式：接收 Promise[]，返回 Promise.all 结果
      // service 内部已调用 prisma.chapter.update（被 mock），$transaction 只需透传
      mockTransaction.mockImplementation((arr: Promise<unknown>[]) => Promise.all(arr));
      // mock chapter.update 返回带 id + sortOrder 的对象
      mockChapter.update.mockImplementation(
        async ({ where, data }: { where: { id: string }; data: { sortOrder: number } }) => ({
          id: where.id,
          sortOrder: data.sortOrder,
        }),
      );

      const result = await reorderChapters('p1', ['c2', 'c1', 'c3']);

      expect(mockChapter.update).toHaveBeenCalledTimes(3);
      // 验证每次调用都传了正确的 where + data
      expect(mockChapter.update).toHaveBeenNthCalledWith(1, {
        where: { id: 'c2' },
        data: { sortOrder: 0 },
        select: { id: true, sortOrder: true },
      });
      expect(result).toEqual([
        { id: 'c2', sortOrder: 0 },
        { id: 'c1', sortOrder: 1 },
        { id: 'c3', sortOrder: 2 },
      ]);
    });
  });

  describe('deleteChapter', () => {
    it('应删除章节', async () => {
      const now = new Date();
      mockChapter.findUnique.mockResolvedValue(sampleDbChapter('c1', now));
      mockChapter.delete.mockResolvedValue({});

      const result = await deleteChapter('c1');

      expect(mockChapter.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(result).toEqual({ id: 'c1' });
    });

    it('章节不存在应抛 CHAPTER_NOT_FOUND', async () => {
      mockChapter.findUnique.mockResolvedValue(null);
      await expect(deleteChapter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHAPTER_NOT_FOUND,
      });
    });
  });
});

/** 生成样本 DB Chapter 记录 */
function sampleDbChapter(id: string, now: Date) {
  return {
    id,
    projectId: 'p1',
    volumeId: null,
    title: 'T',
    content: '',
    wordCount: 0,
    status: 'DRAFT',
    sortOrder: 0,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}
