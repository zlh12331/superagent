// src/main/services/worldview.service.test.ts
// worldview.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Worldview 模型（自关联树形）

import { ErrorCode, type WorldviewCreateInput } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 db-init.test.ts / project.service.test.ts）
const { mockWorldview } = vi.hoisted(() => ({
  mockWorldview: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// mock PrismaClient 单例模块
// 使用 spread + 覆盖 worldview，避免修改共享的 mockPrismaClient
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({ ...mockPrismaClient, worldview: mockWorldview }),
}));

// 直接 import（vi.mock 已提升）
import {
  createWorldview,
  deleteWorldview,
  getWorldviewTree,
  updateWorldview,
} from './worldview.service';

describe('worldview.service', () => {
  beforeEach(() => {
    // resetMocks 重置共享 mockPrismaClient 中所有 model
    // mockWorldview 是局部 mock（仅 5 方法），需单独 reset
    resetMocks();
    mockWorldview.findUnique.mockReset();
    mockWorldview.findMany.mockReset();
    mockWorldview.create.mockReset();
    mockWorldview.update.mockReset();
    mockWorldview.delete.mockReset();
  });

  describe('createWorldview', () => {
    it('应创建根世界观条目（无 parentId）', async () => {
      const now = new Date();
      mockWorldview.create.mockResolvedValue({
        ...sampleDbWorldview('w1', now),
        title: '大陆',
        parentId: null,
      });

      const result = await createWorldview({
        projectId: 'p1',
        title: '大陆',
      } as WorldviewCreateInput);

      expect(mockWorldview.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          parentId: null,
          title: '大陆',
          content: undefined,
          type: undefined,
          icon: undefined,
          sortOrder: 0,
        },
      });
      expect(result.id).toBe('w1');
    });

    it('传入 parentId 时应校验父节点存在且同项目', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValueOnce({
        ...sampleDbWorldview('w1', now),
        projectId: 'p1',
      });
      mockWorldview.create.mockResolvedValue({
        ...sampleDbWorldview('w2', now),
        projectId: 'p1',
        parentId: 'w1',
      });

      await createWorldview({
        projectId: 'p1',
        parentId: 'w1',
        title: '帝国',
      } as WorldviewCreateInput);

      expect(mockWorldview.findUnique).toHaveBeenCalledWith({ where: { id: 'w1' } });
    });

    it('父节点不存在应抛 NOT_FOUND', async () => {
      mockWorldview.findUnique.mockResolvedValue(null);
      await expect(
        createWorldview({ projectId: 'p1', parentId: 'nope', title: 'x' } as WorldviewCreateInput),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });

    it('父节点属于其他项目应抛 NOT_FOUND', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValue({
        ...sampleDbWorldview('w1', now),
        projectId: 'other-project',
      });
      await expect(
        createWorldview({ projectId: 'p1', parentId: 'w1', title: 'x' } as WorldviewCreateInput),
      ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    });
  });

  describe('getWorldviewTree', () => {
    it('应返回扁平数组（按 sortOrder 升序）', async () => {
      const now = new Date();
      mockWorldview.findMany.mockResolvedValue([
        { ...sampleDbWorldview('w1', now), sortOrder: 0 },
        { ...sampleDbWorldview('w2', now), parentId: 'w1', sortOrder: 1 },
      ]);

      const result = await getWorldviewTree('p1');

      expect(mockWorldview.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { sortOrder: 'asc' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('updateWorldview', () => {
    it('应更新字段', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValue(sampleDbWorldview('w1', now));
      mockWorldview.update.mockResolvedValue({
        ...sampleDbWorldview('w1', now),
        title: '新名',
      });

      const result = await updateWorldview({ id: 'w1', title: '新名' });

      expect(mockWorldview.update).toHaveBeenCalledWith({
        where: { id: 'w1' },
        data: { title: '新名' },
      });
      expect(result.title).toBe('新名');
    });

    it('条目不存在应抛 NOT_FOUND', async () => {
      mockWorldview.findUnique.mockResolvedValue(null);
      await expect(updateWorldview({ id: 'nope', title: 'x' })).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('deleteWorldview', () => {
    it('应删除条目（DB 级联删除子节点）', async () => {
      const now = new Date();
      mockWorldview.findUnique.mockResolvedValue(sampleDbWorldview('w1', now));
      mockWorldview.delete.mockResolvedValue({});

      const result = await deleteWorldview('w1');

      expect(mockWorldview.delete).toHaveBeenCalledWith({ where: { id: 'w1' } });
      expect(result).toEqual({ id: 'w1' });
    });

    it('条目不存在应抛 NOT_FOUND', async () => {
      mockWorldview.findUnique.mockResolvedValue(null);
      await expect(deleteWorldview('nope')).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });
});

/** 生成样本 DB Worldview 记录 */
function sampleDbWorldview(id: string, now: Date) {
  return {
    id,
    projectId: 'p1',
    parentId: null,
    title: 'T',
    content: null,
    type: null,
    icon: null,
    sortOrder: 0,
    createdAt: now,
    updatedAt: now,
  };
}
