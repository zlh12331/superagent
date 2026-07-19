// src/main/services/character.service.test.ts
// character.service 单元测试
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Character 模型 / §6.3 AGE 图边

import { ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPrismaClient, resetMocks } from '../__tests__/helpers/mock-prisma';

// vi.hoisted 模式：避免 vi.mock factory TDZ（参考 db-init.test.ts）
// mockCharacter 局部覆盖共享 mockPrismaClient.character（仅 5 方法）
// mockAge 覆盖 age.ts 的 4 个导出函数
const { mockCharacter, mockAge } = vi.hoisted(() => ({
  mockCharacter: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  mockAge: {
    createCharacterVertex: vi.fn(),
    createRelationEdge: vi.fn(),
    executeCypher: vi.fn(),
    queryCypher: vi.fn(),
  },
}));

// mock PrismaClient 单例模块
// 使用 spread + 覆盖 character，避免修改共享的 mockPrismaClient
vi.mock('../infra/prisma/client', () => ({
  getPrismaClient: () => ({
    ...mockPrismaClient,
    character: mockCharacter,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({})),
  }),
}));

// mock age.ts 透传模块（character.service 调用其 4 个导出函数）
vi.mock('../infra/prisma/extensions/age', () => mockAge);

// 直接 import（vi.mock 已提升）
import {
  addCharacterRelation,
  createCharacter,
  deleteCharacter,
  getCharacterRelations,
  listCharacters,
  updateCharacter,
} from './character.service';

describe('character.service', () => {
  beforeEach(() => {
    // resetMocks 重置共享 mockPrismaClient 中所有 model（保持完整 9 方法）
    // mockCharacter / mockAge 是局部 mock，需单独 reset
    resetMocks();
    mockCharacter.findUnique.mockReset();
    mockCharacter.findMany.mockReset();
    mockCharacter.create.mockReset();
    mockCharacter.update.mockReset();
    mockCharacter.delete.mockReset();
    mockAge.createCharacterVertex.mockReset();
    mockAge.createRelationEdge.mockReset();
    mockAge.executeCypher.mockReset();
    mockAge.queryCypher.mockReset();
  });

  describe('createCharacter', () => {
    it('应创建人物并同步创建 AGE 顶点', async () => {
      const now = new Date();
      mockCharacter.create.mockResolvedValue({
        ...sampleDbCharacter('c1', now),
        name: '主角',
        role: 'PROTAGONIST',
      });
      mockAge.createCharacterVertex.mockResolvedValue(1);

      const result = await createCharacter({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
      });

      // 验证 Prisma create 调用（avatar/description 未传 → key 缺失，Vitest 视同 undefined）
      expect(mockCharacter.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          name: '主角',
          avatar: undefined,
          role: 'PROTAGONIST',
          description: undefined,
          profile: {},
        },
      });
      // 验证 AGE 顶点创建调用
      expect(mockAge.createCharacterVertex).toHaveBeenCalledWith(expect.anything(), {
        characterId: 'c1',
        name: '主角',
        role: 'PROTAGONIST',
      });
      expect(result.id).toBe('c1');
    });
  });

  describe('listCharacters', () => {
    it('应返回人物列表（按 createdAt 升序）', async () => {
      const now = new Date();
      mockCharacter.findMany.mockResolvedValue([sampleDbCharacter('c1', now)]);

      const result = await listCharacters('p1');

      expect(mockCharacter.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('updateCharacter', () => {
    it('应更新人物字段', async () => {
      const now = new Date();
      mockCharacter.findUnique.mockResolvedValue(sampleDbCharacter('c1', now));
      mockCharacter.update.mockResolvedValue({
        ...sampleDbCharacter('c1', now),
        name: '新名',
      });

      const result = await updateCharacter({ id: 'c1', name: '新名' });

      expect(mockCharacter.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { name: '新名' },
      });
      expect(result.name).toBe('新名');
    });

    it('人物不存在应抛 CHARACTER_NOT_FOUND', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);
      await expect(updateCharacter({ id: 'nope', name: 'x' })).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
    });
  });

  describe('deleteCharacter', () => {
    it('应删除人物并清理 AGE 顶点（AGE 失败不阻塞）', async () => {
      const now = new Date();
      mockCharacter.findUnique.mockResolvedValue(sampleDbCharacter('c1', now));
      mockCharacter.delete.mockResolvedValue({});
      mockAge.executeCypher.mockRejectedValue(new Error('AGE 不可用'));

      const result = await deleteCharacter('c1');

      expect(mockCharacter.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(mockAge.executeCypher).toHaveBeenCalled();
      expect(result).toEqual({ id: 'c1' });
    });

    it('人物不存在应抛 CHARACTER_NOT_FOUND', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);
      await expect(deleteCharacter('nope')).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
    });
  });

  describe('addCharacterRelation', () => {
    it('应创建人物关系（校验两端存在）', async () => {
      const now = new Date();
      mockCharacter.findUnique
        .mockResolvedValueOnce(sampleDbCharacter('c1', now))
        .mockResolvedValueOnce(sampleDbCharacter('c2', now));
      mockAge.createRelationEdge.mockResolvedValue(1);

      const result = await addCharacterRelation({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
      });

      expect(mockAge.createRelationEdge).toHaveBeenCalledWith(expect.anything(), {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
      });
      expect(result.fromCharacterId).toBe('c1');
    });

    it('from 人物不存在应抛 CHARACTER_NOT_FOUND', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);
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
    it('应通过 Cypher 查询项目下所有关系', async () => {
      mockCharacter.findMany.mockResolvedValue([
        { ...sampleDbCharacter('c1', new Date()), id: 'c1' },
        { ...sampleDbCharacter('c2', new Date()), id: 'c2' },
      ]);
      mockAge.queryCypher.mockResolvedValue([
        { from: 'c1', to: 'c2', type: 'friend', description: '挚友' },
      ]);

      const result = await getCharacterRelations('p1');

      expect(mockAge.queryCypher).toHaveBeenCalled();
      expect(result).toHaveLength(1);
      // noUncheckedIndexedAccess: true 下 result[0] 类型为 T | undefined，用可选链
      expect(result[0]?.fromCharacterId).toBe('c1');
    });
  });
});

/** 生成样本 DB Character 记录 */
function sampleDbCharacter(id: string, now: Date) {
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
  };
}
