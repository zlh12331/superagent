// src/main/services/project.service.test.ts
// project.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Project 模型

import { ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 db-init.test.ts）
const { mockProject } = vi.hoisted(() => ({
  mockProject: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
}));

// mock PrismaClient 单例模块
// 使用 spread + 覆盖 project，避免修改共享的 mockPrismaClient（参考 chapter.service.test.ts 模式）
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({ ...mockPrismaClient, project: mockProject }),
}));

// 直接 import（vi.mock 已提升）
import {
  archiveProject,
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from './project.service';

describe('project.service', () => {
  beforeEach(() => {
    // resetMocks 重置共享 mockPrismaClient 中所有 model（保持完整 9 方法）
    // mockProject 是局部 mock（仅 5 方法），需单独 reset
    resetMocks();
    mockProject.findUnique.mockReset();
    mockProject.findMany.mockReset();
    mockProject.create.mockReset();
    mockProject.update.mockReset();
    mockProject.delete.mockReset();
  });

  describe('createProject', () => {
    it('应创建项目并返回 Project', async () => {
      const input = { name: '我的新书' };
      const now = new Date();
      const created = {
        id: 'c1',
        name: '我的新书',
        description: null,
        genre: null,
        cover: null,
        status: 'ACTIVE',
        metadata: {},
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      };
      mockProject.create.mockResolvedValue(created);

      const result = await createProject(input);

      expect(mockProject.create).toHaveBeenCalledWith({
        data: {
          name: '我的新书',
          description: undefined,
          genre: undefined,
          cover: undefined,
        },
      });
      expect(result).toEqual({
        id: 'c1',
        name: '我的新书',
        description: null,
        genre: null,
        cover: null,
        status: 'ACTIVE',
        metadata: {},
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        archivedAt: null,
      });
    });
  });

  describe('listProjects', () => {
    it('应返回项目列表（按 updatedAt 倒序）', async () => {
      const now = new Date();
      const projects = [
        { ...sampleDbProject('p1', 'A', now), updatedAt: now },
        { ...sampleDbProject('p2', 'B', now), updatedAt: now },
      ];
      mockProject.findMany.mockResolvedValue(projects);

      const result = await listProjects();

      expect(mockProject.findMany).toHaveBeenCalledWith({
        orderBy: [{ archivedAt: 'asc' }, { updatedAt: 'desc' }],
        where: { archivedAt: null },
      });
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('p1');
    });
  });

  describe('getProject', () => {
    it('应返回单个项目', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', 'A', now));

      const result = await getProject('p1');

      expect(mockProject.findUnique).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(result.id).toBe('p1');
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);

      await expect(getProject('not-exist')).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });

  describe('updateProject', () => {
    it('应更新项目字段', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', '旧名', now));
      const updated = { ...sampleDbProject('p1', '新名', now), genre: '玄幻' };
      mockProject.update.mockResolvedValue(updated);

      const result = await updateProject({ id: 'p1', name: '新名', genre: '玄幻' });

      expect(mockProject.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { name: '新名', genre: '玄幻' },
      });
      expect(result.name).toBe('新名');
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);
      await expect(updateProject({ id: 'nope', name: 'x' })).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });

  describe('deleteProject', () => {
    it('应删除项目', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', 'A', now));
      mockProject.delete.mockResolvedValue({});

      const result = await deleteProject('p1');

      expect(mockProject.delete).toHaveBeenCalledWith({ where: { id: 'p1' } });
      expect(result).toEqual({ id: 'p1' });
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);
      await expect(deleteProject('nope')).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });

  describe('archiveProject', () => {
    it('应归档项目（status=ARCHIVED + archivedAt）', async () => {
      const now = new Date();
      mockProject.findUnique.mockResolvedValue(sampleDbProject('p1', 'A', now));
      const archived = {
        ...sampleDbProject('p1', 'A', now),
        status: 'ARCHIVED',
        archivedAt: now,
      };
      mockProject.update.mockResolvedValue(archived);

      const result = await archiveProject('p1');

      expect(mockProject.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { status: 'ARCHIVED', archivedAt: expect.any(Date) },
      });
      expect(result.status).toBe('ARCHIVED');
    });

    it('项目不存在应抛 PROJECT_NOT_FOUND', async () => {
      mockProject.findUnique.mockResolvedValue(null);
      await expect(archiveProject('nope')).rejects.toMatchObject({
        code: ErrorCode.PROJECT_NOT_FOUND,
      });
    });
  });
});

/** 生成样本 DB Project 记录 */
function sampleDbProject(id: string, name: string, now: Date) {
  return {
    id,
    name,
    description: null,
    genre: null,
    cover: null,
    status: 'ACTIVE',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}
