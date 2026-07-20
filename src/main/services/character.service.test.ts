// src/main/services/character.service.test.ts
// character.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Character 模型 / §6.3 AGE 图边
//
// 测试策略（设计文档 §4.3 Repository 模式）：
// - mock CharacterRepository：service 只做编排，Repository 已独立测试覆盖 Prisma + AGE 双写
// - 不 mock Prisma / AGE：避免重复 Repository 测试已覆盖的逻辑
// - 验证 service 是否正确委托 + 日志 + 错误透传
//
// 注意：
// - vi.hoisted 模式避免 vi.mock factory TDZ（参考 db-init.test.ts）
// - 用 class 表达式 mock CharacterRepository（vi.fn() 不能直接作为 class）
// - getPrismaClient 也 mock（service 内部调用拿 prisma 引用，传给 MockRepository 但不会真实使用）

import { AppError, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted：mock CharacterRepository + getPrismaClient（避免 vi.mock factory TDZ）
const { mockRepo, MockCharacterRepository } = vi.hoisted(() => {
  const mockRepo = {
    create: vi.fn(),
    findById: vi.fn(),
    listByProject: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    addRelation: vi.fn(),
    findRelations: vi.fn(),
  };
  // 用 class 表达式 mock `new CharacterRepository(prisma)` 返回 mockRepo 实例
  // 字段初始化器确保每个 new 实例都共享同一组 mock（service 每次 new 新 Repository）
  class MockCharacterRepository {
    create = mockRepo.create;
    findById = mockRepo.findById;
    listByProject = mockRepo.listByProject;
    update = mockRepo.update;
    delete = mockRepo.delete;
    addRelation = mockRepo.addRelation;
    findRelations = mockRepo.findRelations;
  }
  return {
    mockRepo,
    // biome-ignore lint/style/useNamingConvention: 必须匹配源 class 名 CharacterRepository
    MockCharacterRepository,
  };
});

// mock CharacterRepository 类（service 通过 `new CharacterRepository(prisma)` 实例化）
vi.mock('../infra/repositories/character.repository', () => ({
  // biome-ignore lint/style/useNamingConvention: 必须匹配源 class 名 CharacterRepository
  CharacterRepository: MockCharacterRepository,
}));

// mock getPrismaClient（service 内部调用拿 prisma 引用，传给 MockRepository 但不会真实使用）
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({}),
}));

import {
  addCharacterRelation,
  createCharacter,
  deleteCharacter,
  getCharacterRelations,
  listCharacters,
  updateCharacter,
} from './character.service';

/** 生成样本 Character（IPC 兼容的字符串日期格式） */
function sampleCharacter(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
): {
  id: string;
  projectId: string;
  name: string;
  avatar: string | null;
  role: string;
  description: string | null;
  profile: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
} {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id,
    projectId: 'p1',
    name: 'N',
    avatar: null,
    role: 'SUPPORTING',
    description: null,
    profile: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('character.service', () => {
  beforeEach(() => {
    mockRepo.create.mockReset();
    mockRepo.findById.mockReset();
    mockRepo.listByProject.mockReset();
    mockRepo.update.mockReset();
    mockRepo.delete.mockReset();
    mockRepo.addRelation.mockReset();
    mockRepo.findRelations.mockReset();
  });

  describe('createCharacter', () => {
    it('应委托 Repository.create 创建人物', async () => {
      const created = sampleCharacter('c1', { name: '主角', role: 'PROTAGONIST' });
      mockRepo.create.mockResolvedValue(created);

      const result = await createCharacter({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
      });

      // 验证 Repository.create 收到完整入参
      expect(mockRepo.create).toHaveBeenCalledWith({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
      });
      expect(result).toEqual(created);
    });
  });

  describe('listCharacters', () => {
    it('应委托 Repository.listByProject 返回人物列表', async () => {
      const list = [sampleCharacter('c1')];
      mockRepo.listByProject.mockResolvedValue(list);

      const result = await listCharacters('p1');

      expect(mockRepo.listByProject).toHaveBeenCalledWith('p1');
      expect(result).toEqual(list);
    });
  });

  describe('updateCharacter', () => {
    it('应委托 Repository.update 更新人物', async () => {
      const updated = sampleCharacter('c1', { name: '新名' });
      mockRepo.update.mockResolvedValue(updated);

      const result = await updateCharacter({ id: 'c1', name: '新名' });

      expect(mockRepo.update).toHaveBeenCalledWith({ id: 'c1', name: '新名' });
      expect(result.name).toBe('新名');
    });

    it('Repository 抛 CHARACTER_NOT_FOUND 时应透传', async () => {
      mockRepo.update.mockRejectedValue(
        new AppError(ErrorCode.CHARACTER_NOT_FOUND, '人物不存在：nope'),
      );
      await expect(updateCharacter({ id: 'nope', name: 'x' })).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
    });
  });

  describe('deleteCharacter', () => {
    it('应委托 Repository.delete 删除人物并返回 { id }', async () => {
      mockRepo.delete.mockResolvedValue(undefined);

      const result = await deleteCharacter('c1');

      expect(mockRepo.delete).toHaveBeenCalledWith('c1');
      expect(result).toEqual({ id: 'c1' });
    });

    it('Repository 抛 CHARACTER_NOT_FOUND 时应透传', async () => {
      mockRepo.delete.mockRejectedValue(
        new AppError(ErrorCode.CHARACTER_NOT_FOUND, '人物不存在：nope'),
      );
      await expect(deleteCharacter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
    });
  });

  describe('addCharacterRelation', () => {
    it('应委托 Repository.addRelation 添加关系并原样返回入参', async () => {
      mockRepo.addRelation.mockResolvedValue(undefined);

      const result = await addCharacterRelation({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
      });

      expect(mockRepo.addRelation).toHaveBeenCalledWith({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
      });
      expect(result.fromCharacterId).toBe('c1');
    });

    it('Repository 抛 CHARACTER_NOT_FOUND 时应透传', async () => {
      mockRepo.addRelation.mockRejectedValue(
        new AppError(ErrorCode.CHARACTER_NOT_FOUND, '起始人物不存在：nope'),
      );
      await expect(
        addCharacterRelation({
          fromCharacterId: 'nope',
          toCharacterId: 'c2',
          type: 'friend',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CHARACTER_NOT_FOUND });
    });
  });

  describe('getCharacterRelations', () => {
    it('应委托 Repository.findRelations 查询关系', async () => {
      mockRepo.findRelations.mockResolvedValue([
        {
          fromCharacterId: 'c1',
          toCharacterId: 'c2',
          type: 'friend',
          description: '挚友',
        },
      ]);

      const result = await getCharacterRelations('p1');

      expect(mockRepo.findRelations).toHaveBeenCalledWith('p1');
      expect(result).toHaveLength(1);
      // noUncheckedIndexedAccess: true 下 result[0] 类型为 T | undefined，用可选链
      expect(result[0]?.fromCharacterId).toBe('c1');
    });

    it('Repository 降级返回空数组时应透传空数组', async () => {
      mockRepo.findRelations.mockResolvedValue([]);

      const result = await getCharacterRelations('p1');

      expect(result).toEqual([]);
    });
  });
});
