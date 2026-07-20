// src/main/infra/repositories/character.repository.test.ts
// CharacterRepository 单元测试
//
// 测试策略（设计文档 §4.3 Repository 模式）：
// - mock PrismaClient.character CRUD + $transaction：不依赖真实 DB
// - mock age 扩展（createCharacterVertex / createRelationEdge / executeCypher / queryCypher）：
//   AGE 是 PG 扩展二进制，单元测试不验证真实 Cypher 行为，只验证 Repository 编排逻辑
// - mock logger：避免实际日志输出污染测试
// - 验证点：
//   1. Prisma + AGE 双写顺序与原子性（$transaction 包裹）
//   2. AGE 失败仅 warn 不阻塞 Prisma 业务（容错降级）
//   3. 读操作失败降级为空数组（前端优雅降级）
//   4. AppError 错误码透传（CHARACTER_NOT_FOUND）
//   5. Date 字段序列化为 ISO 字符串（IPC 兼容）
//
// 注意：
// - vi.hoisted 模式避免 vi.mock factory TDZ（参考 character.service.test.ts / db-init.test.ts）
// - $transaction mock 实现：直接调用 cb(mockTx) 让事务内逻辑可测
// - findRelations 已知生产 bug（queryCypher 列名不匹配导致始终返回 []）：
//   单元测试用理想化 mock 验证 Repository 过滤逻辑，不验证 AGE 实际返回形状

import { AppError, type Character, ErrorCode } from '@novel-writer/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// vi.hoisted：mock Prisma + AGE 扩展 + logger（避免 vi.mock factory TDZ）
const {
  mockCharacter,
  mockTx,
  mockPrisma,
  mockCreateCharacterVertex,
  mockCreateRelationEdge,
  mockExecuteCypher,
  mockQueryCypher,
} = vi.hoisted(() => {
  // prisma.character.* 方法 mock
  const mockCharacter = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  // $transaction 回调入参：仅含 Repository 内部用到的 tx.character.findUnique
  const mockTx = {
    character: {
      findUnique: vi.fn(),
    },
  };
  // PrismaClient mock：character 模型 + $transaction（直接同步执行 cb）
  const mockPrisma = {
    character: mockCharacter,
    $transaction: vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx)),
  };
  return {
    mockCharacter,
    mockTx,
    mockPrisma,
    mockCreateCharacterVertex: vi.fn(),
    mockCreateRelationEdge: vi.fn(),
    mockExecuteCypher: vi.fn(),
    mockQueryCypher: vi.fn(),
  };
});

// mock age 扩展模块（Repository 通过 import 调用这些函数）
vi.mock('../prisma/extensions/age', () => ({
  createCharacterVertex: mockCreateCharacterVertex,
  createRelationEdge: mockCreateRelationEdge,
  executeCypher: mockExecuteCypher,
  queryCypher: mockQueryCypher,
}));

// mock logger（避免 AGE 失败时实际日志输出污染测试）
vi.mock('../../utils/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// 静态导入被测模块：vi.mock 已 hoist，mock 此时已生效
import { CharacterRepository } from './character.repository';

/**
 * 生成 Prisma 原始 Character 记录（Date 字段，未序列化）
 *
 * @param id 人物 ID
 * @param overrides 覆盖字段
 */
function sampleRawCharacter(
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
  createdAt: Date;
  updatedAt: Date;
} {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id,
    projectId: 'p1',
    name: '主角',
    avatar: null,
    role: 'PROTAGONIST',
    description: null,
    profile: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('CharacterRepository', () => {
  let repo: CharacterRepository;

  beforeEach(() => {
    repo = new CharacterRepository(mockPrisma as never);
    // mockReset 完全隔离（参考 age.test.ts）
    mockCharacter.create.mockReset();
    mockCharacter.findUnique.mockReset();
    mockCharacter.findMany.mockReset();
    mockCharacter.update.mockReset();
    mockCharacter.delete.mockReset();
    mockTx.character.findUnique.mockReset();
    mockPrisma.$transaction.mockClear();
    mockCreateCharacterVertex.mockReset();
    mockCreateRelationEdge.mockReset();
    mockExecuteCypher.mockReset();
    mockQueryCypher.mockReset();
    // 默认 $transaction 直接执行 cb(mockTx)
    mockPrisma.$transaction.mockImplementation(
      async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx),
    );
  });

  describe('create', () => {
    it('应创建人物 + 同步 AGE 顶点，返回序列化后的 Character', async () => {
      const raw = sampleRawCharacter('c1');
      mockCharacter.create.mockResolvedValue(raw);
      mockCreateCharacterVertex.mockResolvedValue(1);

      const result = await repo.create({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
      });

      // Prisma.create 收到正确入参（profile 默认 {}）
      expect(mockCharacter.create).toHaveBeenCalledWith({
        data: {
          projectId: 'p1',
          name: '主角',
          role: 'PROTAGONIST',
          profile: {},
        },
      });
      // AGE 顶点创建收到 Prisma 返回的 id/name/role
      expect(mockCreateCharacterVertex).toHaveBeenCalledWith(mockPrisma, {
        characterId: 'c1',
        name: '主角',
        role: 'PROTAGONIST',
      });
      // 返回值是 IPC 兼容的 ISO 字符串日期
      expect(result).toMatchObject({
        id: 'c1',
        name: '主角',
        role: 'PROTAGONIST',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
    });

    it('应传入可选字段 avatar 与 description（条件展开）', async () => {
      const raw = sampleRawCharacter('c1', { avatar: 'http://x/a.png', description: '描述' });
      mockCharacter.create.mockResolvedValue(raw);
      mockCreateCharacterVertex.mockResolvedValue(1);

      await repo.create({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
        avatar: 'http://x/a.png',
        description: '描述',
      });

      // 条件展开：avatar/description 非空时写入 data
      expect(mockCharacter.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          avatar: 'http://x/a.png',
          description: '描述',
        }),
      });
    });

    it('AGE 顶点创建失败时应仅 warn 不阻塞 Prisma 业务', async () => {
      const raw = sampleRawCharacter('c1');
      mockCharacter.create.mockResolvedValue(raw);
      mockCreateCharacterVertex.mockRejectedValue(new Error('AGE 不可用'));

      // 不应抛错（AGE 失败仅 warn）
      const result = await repo.create({
        projectId: 'p1',
        name: '主角',
        role: 'PROTAGONIST',
      });

      // Prisma 已写入，返回值正常
      expect(result.id).toBe('c1');
    });
  });

  describe('findById', () => {
    it('应返回序列化后的人物', async () => {
      const raw = sampleRawCharacter('c1');
      mockCharacter.findUnique.mockResolvedValue(raw);

      const result = await repo.findById('c1');

      expect(mockCharacter.findUnique).toHaveBeenCalledWith({ where: { id: 'c1' } });
      expect(result?.id).toBe('c1');
      expect(result?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('人物不存在时应返回 null', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);

      const result = await repo.findById('nope');

      expect(result).toBeNull();
    });
  });

  describe('listByProject', () => {
    it('应返回按 createdAt 升序的序列化列表', async () => {
      const rawList = [
        sampleRawCharacter('c1', { createdAt: new Date('2026-01-01T00:00:00.000Z') }),
        sampleRawCharacter('c2', { createdAt: new Date('2026-01-02T00:00:00.000Z') }),
      ];
      mockCharacter.findMany.mockResolvedValue(rawList);

      const result = await repo.listByProject('p1');

      expect(mockCharacter.findMany).toHaveBeenCalledWith({
        where: { projectId: 'p1' },
        orderBy: { createdAt: 'asc' },
      });
      expect(result).toHaveLength(2);
      expect(result[0]?.id).toBe('c1');
      expect(result[1]?.id).toBe('c2');
      // 序列化：Date → ISO 字符串
      expect(result[0]?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('项目下无人物时应返回空数组', async () => {
      mockCharacter.findMany.mockResolvedValue([]);

      const result = await repo.listByProject('p1');

      expect(result).toEqual([]);
    });
  });

  describe('update', () => {
    it('人物不存在时应抛 AppError(CHARACTER_NOT_FOUND)', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);

      await expect(repo.update({ id: 'nope', name: '新名' })).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
      // 不应调用 update
      expect(mockCharacter.update).not.toHaveBeenCalled();
    });

    it('更新 name 应触发 AGE 顶点同步（$transaction 内删旧+建新）', async () => {
      const existing = sampleRawCharacter('c1', { name: '旧名' });
      const updated = sampleRawCharacter('c1', { name: '新名' });
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.update.mockResolvedValue(updated);
      mockExecuteCypher.mockResolvedValue(1);
      mockCreateCharacterVertex.mockResolvedValue(1);

      const result = await repo.update({ id: 'c1', name: '新名' });

      // Prisma.update 收到过滤 undefined 后的 payload
      expect(mockCharacter.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { name: '新名' },
      });
      // $transaction 被调用一次（AGE 删旧+建新）
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // 事务内：先 executeCypher 删旧顶点
      expect(mockExecuteCypher).toHaveBeenCalledWith(
        mockTx,
        expect.stringContaining("MATCH (n:Character {characterId: 'c1'})"),
      );
      expect(mockExecuteCypher).toHaveBeenCalledWith(
        mockTx,
        expect.stringContaining('DETACH DELETE'),
      );
      // 事务内：再 createCharacterVertex 建新顶点
      expect(mockCreateCharacterVertex).toHaveBeenCalledWith(mockTx, {
        characterId: 'c1',
        name: '新名',
        role: 'PROTAGONIST',
      });
      expect(result.name).toBe('新名');
    });

    it('更新 role 应触发 AGE 顶点同步', async () => {
      const existing = sampleRawCharacter('c1', { role: 'PROTAGONIST' });
      const updated = sampleRawCharacter('c1', { role: 'ANTAGONIST' });
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.update.mockResolvedValue(updated);
      mockExecuteCypher.mockResolvedValue(1);
      mockCreateCharacterVertex.mockResolvedValue(1);

      await repo.update({ id: 'c1', role: 'ANTAGONIST' });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockCreateCharacterVertex).toHaveBeenCalledWith(mockTx, {
        characterId: 'c1',
        name: '主角',
        role: 'ANTAGONIST',
      });
    });

    it('仅更新 description（无 name/role 变化）不应触发 AGE 同步', async () => {
      const existing = sampleRawCharacter('c1');
      const updated = sampleRawCharacter('c1', { description: '新描述' });
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.update.mockResolvedValue(updated);

      await repo.update({ id: 'c1', description: '新描述' });

      expect(mockCharacter.update).toHaveBeenCalledWith({
        where: { id: 'c1' },
        data: { description: '新描述' },
      });
      // 不应调用 $transaction（无 name/role 变化）
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(mockExecuteCypher).not.toHaveBeenCalled();
      expect(mockCreateCharacterVertex).not.toHaveBeenCalled();
    });

    it('AGE 同步失败应仅 warn 不阻塞 Prisma 业务', async () => {
      const existing = sampleRawCharacter('c1');
      const updated = sampleRawCharacter('c1', { name: '新名' });
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.update.mockResolvedValue(updated);
      // $transaction 内 executeCypher 抛错
      mockExecuteCypher.mockRejectedValue(new Error('AGE 同步失败'));

      // 不应抛错
      const result = await repo.update({ id: 'c1', name: '新名' });

      // Prisma 已更新，返回新值
      expect(result.name).toBe('新名');
    });

    it('updatePayload 应过滤 undefined 字段（避免 Prisma 显式 undefined 错误）', async () => {
      const existing = sampleRawCharacter('c1');
      const updated = sampleRawCharacter('c1', { name: '新名' });
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.update.mockResolvedValue(updated);
      mockExecuteCypher.mockResolvedValue(1);
      mockCreateCharacterVertex.mockResolvedValue(1);

      // 传入 description: undefined（不应出现在 updatePayload）
      await repo.update({ id: 'c1', name: '新名', description: undefined });

      const updateCall = mockCharacter.update.mock.calls[0]?.[0] as {
        data: Record<string, unknown>;
      };
      // undefined 字段应被过滤掉
      expect(updateCall.data).not.toHaveProperty('description');
      expect(updateCall.data).toHaveProperty('name', '新名');
    });
  });

  describe('delete', () => {
    it('人物不存在时应抛 AppError(CHARACTER_NOT_FOUND)', async () => {
      mockCharacter.findUnique.mockResolvedValue(null);

      await expect(repo.delete('nope')).rejects.toMatchObject({
        code: ErrorCode.CHARACTER_NOT_FOUND,
      });
      expect(mockCharacter.delete).not.toHaveBeenCalled();
    });

    it('应删除人物 + 清理 AGE 顶点（DETACH DELETE 关联边）', async () => {
      const existing = sampleRawCharacter('c1');
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.delete.mockResolvedValue(existing);
      mockExecuteCypher.mockResolvedValue(1);

      await repo.delete('c1');

      expect(mockCharacter.delete).toHaveBeenCalledWith({ where: { id: 'c1' } });
      // executeCypher 收到含 characterId 的 DETACH DELETE 语句
      expect(mockExecuteCypher).toHaveBeenCalledWith(
        mockPrisma,
        expect.stringContaining("MATCH (n:Character {characterId: 'c1'}) DETACH DELETE n"),
      );
    });

    it('AGE 顶点清理失败应仅 warn 不阻塞 Prisma 删除', async () => {
      const existing = sampleRawCharacter('c1');
      mockCharacter.findUnique.mockResolvedValue(existing);
      mockCharacter.delete.mockResolvedValue(existing);
      mockExecuteCypher.mockRejectedValue(new Error('AGE 不可用'));

      // 不应抛错（Prisma 已删，AGE 残留孤儿顶点由业务策略接受）
      await repo.delete('c1');

      expect(mockCharacter.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('addRelation', () => {
    it('起始人物不存在时应抛 AppError(CHARACTER_NOT_FOUND)', async () => {
      // 事务内 fromChar 查询返回 null
      mockTx.character.findUnique.mockResolvedValueOnce(null);

      await expect(
        repo.addRelation({
          fromCharacterId: 'nope',
          toCharacterId: 'c2',
          type: 'friend',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CHARACTER_NOT_FOUND });
      // 不应创建边
      expect(mockCreateRelationEdge).not.toHaveBeenCalled();
    });

    it('目标人物不存在时应抛 AppError(CHARACTER_NOT_FOUND)', async () => {
      // fromChar 存在，toChar 不存在
      mockTx.character.findUnique.mockResolvedValueOnce(sampleRawCharacter('c1'));
      mockTx.character.findUnique.mockResolvedValueOnce(null);

      await expect(
        repo.addRelation({
          fromCharacterId: 'c1',
          toCharacterId: 'nope',
          type: 'friend',
        }),
      ).rejects.toMatchObject({ code: ErrorCode.CHARACTER_NOT_FOUND });
      expect(mockCreateRelationEdge).not.toHaveBeenCalled();
    });

    it('两端人物都存在时应调用 createRelationEdge（含可选字段）', async () => {
      mockTx.character.findUnique.mockResolvedValueOnce(sampleRawCharacter('c1'));
      mockTx.character.findUnique.mockResolvedValueOnce(sampleRawCharacter('c2'));
      mockCreateRelationEdge.mockResolvedValue(1);

      await repo.addRelation({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
        chapterId: 'ch1',
      });

      // createRelationEdge 在事务内调用，收到完整入参
      expect(mockCreateRelationEdge).toHaveBeenCalledWith(mockTx, {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
        chapterId: 'ch1',
      });
    });

    it('可选字段 description/chapterId 未传时不应出现在 createRelationEdge 入参', async () => {
      mockTx.character.findUnique.mockResolvedValueOnce(sampleRawCharacter('c1'));
      mockTx.character.findUnique.mockResolvedValueOnce(sampleRawCharacter('c2'));
      mockCreateRelationEdge.mockResolvedValue(1);

      await repo.addRelation({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'enemy',
      });

      // 条件展开：description/chapterId undefined 时不写入
      expect(mockCreateRelationEdge).toHaveBeenCalledWith(mockTx, {
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'enemy',
      });
    });
  });

  describe('findRelations', () => {
    it('项目下无人物时应直接返回空数组（不调用 AGE 查询）', async () => {
      mockCharacter.findMany.mockResolvedValue([]);

      const result = await repo.findRelations('p1');

      expect(result).toEqual([]);
      // 不应调用 queryCypher（无意义查询）
      expect(mockQueryCypher).not.toHaveBeenCalled();
    });

    it('AGE 查询失败时应降级返回空数组（前端优雅降级）', async () => {
      mockCharacter.findMany.mockResolvedValue([
        sampleRawCharacter('c1'),
        sampleRawCharacter('c2'),
      ]);
      mockQueryCypher.mockRejectedValue(new Error('AGE 不可用'));

      const result = await repo.findRelations('p1');

      expect(result).toEqual([]);
    });

    it('应过滤掉跨项目的关系（from/to 必须都在项目内）', async () => {
      // 项目 p1 包含 c1, c2
      mockCharacter.findMany.mockResolvedValue([
        sampleRawCharacter('c1'),
        sampleRawCharacter('c2'),
      ]);
      // mock 返回 3 条关系：c1→c2（保留）、c1→c3（c3 不在项目内，过滤）、c3→c2（c3 不在项目内，过滤）
      mockQueryCypher.mockResolvedValue([
        { from: 'c1', to: 'c2', type: 'friend' },
        { from: 'c1', to: 'c3', type: 'enemy' },
        { from: 'c3', to: 'c2', type: 'mentor' },
      ]);

      const result = await repo.findRelations('p1');

      // 仅保留 from/to 都在项目内的关系
      expect(result).toEqual([
        {
          fromCharacterId: 'c1',
          toCharacterId: 'c2',
          type: 'friend',
        },
      ]);
    });

    it('应保留含 description 的关系（可选字段透传）', async () => {
      mockCharacter.findMany.mockResolvedValue([
        sampleRawCharacter('c1'),
        sampleRawCharacter('c2'),
      ]);
      mockQueryCypher.mockResolvedValue([
        { from: 'c1', to: 'c2', type: 'friend', description: '挚友' },
      ]);

      const result = await repo.findRelations('p1');

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        fromCharacterId: 'c1',
        toCharacterId: 'c2',
        type: 'friend',
        description: '挚友',
      });
    });
  });

  describe('序列化行为', () => {
    it('Date 字段应序列化为 ISO 字符串（IPC 兼容）', async () => {
      const raw = sampleRawCharacter('c1', {
        createdAt: new Date('2026-07-20T10:30:00.000Z'),
        updatedAt: new Date('2026-07-20T11:00:00.000Z'),
      });
      mockCharacter.findUnique.mockResolvedValue(raw);

      const result = (await repo.findById('c1')) as Character;

      expect(result.createdAt).toBe('2026-07-20T10:30:00.000Z');
      expect(result.updatedAt).toBe('2026-07-20T11:00:00.000Z');
      // AppError 实例化校验（覆盖 AppError 类构造逻辑）
      const err = new AppError(ErrorCode.CHARACTER_NOT_FOUND, 'test');
      expect(err).toBeInstanceOf(AppError);
      expect(err.code).toBe(ErrorCode.CHARACTER_NOT_FOUND);
    });

    it('null 字段应保留 null 语义（avatar/description 可空字段）', async () => {
      const raw = sampleRawCharacter('c1', { avatar: null, description: null });
      mockCharacter.findUnique.mockResolvedValue(raw);

      const result = (await repo.findById('c1')) as Character;

      // null 应显式保留（不是 undefined）
      expect(result.avatar).toBeNull();
      expect(result.description).toBeNull();
    });
  });
});
