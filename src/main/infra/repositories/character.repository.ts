// src/main/infra/repositories/character.repository.ts
// 人物领域 Repository（设计文档 §4.3 infra 层 Repository 模式）
//
// 职责：
// 1. 封装 Prisma + AGE 双写（应用层无需感知双存储）
// 2. 用 $transaction 保证多步 AGE 操作的原子性（如 update 的"删旧+建新"）
// 3. AGE 失败仅 warn 不阻塞（业务策略 §6.5 容错降级）
// 4. 读操作（findRelations）失败时降级为空数组（前端优雅降级）
//
// 设计原则：
// - service 层只调 repository，不直接访问 Prisma / AGE
// - repository 内部封装 SQL/Cypher 细节，业务层不感知
// - 事务边界由 repository 决定，service 无需关心
//
// 注意：
// - AGE 1.5 支持 PostgreSQL 事务回滚（CREATE VERTEX 可回滚）
// - 但业务策略保留"AGE 失败不阻塞 Prisma"，故 AGE 操作失败时仅 warn
// - update 的"删旧+建新"用 $transaction 包裹保证 AGE 端原子性

import {
  AppError,
  type Character,
  type CharacterCreateInput,
  type CharacterRelationInput,
  type CharacterUpdateInput,
  ErrorCode,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { logger } from '../../utils/logger';
import {
  createCharacterVertex,
  createRelationEdge,
  executeCypher,
  queryCypher,
} from '../prisma/extensions/age';

/**
 * 人物领域 Repository
 *
 * 封装 Prisma character 表 + AGE Character 顶点 / RELATION 边的双写一致性
 *
 * @example
 * ```ts
 * const repo = new CharacterRepository(prisma);
 * const created = await repo.create({ projectId: 'p1', name: '主角', role: 'PROTAGONIST' });
 * ```
 */
export class CharacterRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * 创建人物 + 同步创建 AGE 顶点
   *
   * AGE 失败仅 warn（业务策略：保证 Prisma 主流程可用）
   */
  async create(input: CharacterCreateInput): Promise<Character> {
    // 条件展开：exactOptionalPropertyTypes 下 Prisma 不接受显式 undefined
    const created = await this.prisma.character.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        role: input.role,
        profile: (input.profile ?? {}) as never,
        ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      },
    });

    // AGE 顶点创建（失败不阻塞 Prisma 业务）
    try {
      await createCharacterVertex(this.prisma, {
        characterId: created.id,
        name: created.name,
        role: created.role,
      });
    } catch (err) {
      logger.warn(
        { characterId: created.id, error: err instanceof Error ? err.message : String(err) },
        'AGE 顶点创建失败（不阻塞 Prisma 业务）',
      );
    }

    return serializeCharacter(created);
  }

  /**
   * 按 ID 查找人物
   *
   * @returns 人物；不存在返回 null
   */
  async findById(id: string): Promise<Character | null> {
    const found = await this.prisma.character.findUnique({ where: { id } });
    return found === null ? null : serializeCharacter(found);
  }

  /**
   * 列出项目下所有人物（按 createdAt 升序）
   */
  async listByProject(projectId: string): Promise<Character[]> {
    const characters = await this.prisma.character.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return characters.map(serializeCharacter);
  }

  /**
   * 更新人物字段
   *
   * 同步更新 AGE 顶点（删旧顶点 + 建新顶点），用 $transaction 保证 AGE 端原子性
   * - 若第二步失败，第一步回滚（避免顶点丢失）
   * - AGE 操作整体失败仅 warn，不阻塞 Prisma 业务
   *
   * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
   */
  async update(input: CharacterUpdateInput): Promise<Character> {
    // 先检查存在（提供更友好的错误码）
    const existing = await this.prisma.character.findUnique({ where: { id: input.id } });
    if (existing === null) {
      throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `人物不存在：${input.id}`);
    }

    // 提取除 id 之外的更新字段
    const { id: _id, ...updateData } = input;
    // 过滤 undefined 值（exactOptionalPropertyTypes 下 Prisma 不接受显式 undefined）
    const updatePayload = Object.fromEntries(
      Object.entries(updateData).filter(([, value]) => value !== undefined),
    ) as never;

    const updated = await this.prisma.character.update({
      where: { id: input.id },
      data: updatePayload,
    });

    // 仅在 name/role 变化时同步更新 AGE 顶点
    if (input.name !== undefined || input.role !== undefined) {
      // 用 $transaction 包裹"删旧+建新"，保证 AGE 端原子性
      // AGE 1.5 支持 PostgreSQL 事务回滚，第一步失败时第二步不会执行
      try {
        await this.prisma.$transaction(async (tx) => {
          await executeCypher(
            tx,
            `MATCH (n:Character {characterId: '${input.id}'}) DETACH DELETE n`,
          );
          await createCharacterVertex(tx, {
            characterId: updated.id,
            name: updated.name,
            role: updated.role,
          });
        });
      } catch (err) {
        logger.warn(
          { characterId: input.id, error: err instanceof Error ? err.message : String(err) },
          'AGE 顶点更新失败（不阻塞）',
        );
      }
    }

    return serializeCharacter(updated);
  }

  /**
   * 删除人物 + 清理 AGE 顶点与关联边
   *
   * AGE 清理失败仅 warn（不阻塞 Prisma 删除，DB 已删，AGE 残留孤儿顶点）
   *
   * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
   */
  async delete(id: string): Promise<void> {
    const existing = await this.prisma.character.findUnique({ where: { id } });
    if (existing === null) {
      throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `人物不存在：${id}`);
    }

    await this.prisma.character.delete({ where: { id } });

    // 清理 AGE 顶点（DETACH DELETE 自动删除所有关联边）
    try {
      await executeCypher(
        this.prisma,
        `MATCH (n:Character {characterId: '${id}'}) DETACH DELETE n`,
      );
    } catch (err) {
      logger.warn(
        { characterId: id, error: err instanceof Error ? err.message : String(err) },
        'AGE 顶点清理失败（不阻塞删除）',
      );
    }
  }

  /**
   * 添加人物关系（AGE 图边）
   *
   * 用 $transaction 包裹"校验 + 创建边"，保证校验与写入的一致性
   *
   * @throws AppError(CHARACTER_NOT_FOUND) from/to 人物不存在
   */
  async addRelation(input: CharacterRelationInput): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 校验两端人物存在（在事务内查询，避免并发删除）
      const fromChar = await tx.character.findUnique({
        where: { id: input.fromCharacterId },
      });
      if (fromChar === null) {
        throw new AppError(
          ErrorCode.CHARACTER_NOT_FOUND,
          `起始人物不存在：${input.fromCharacterId}`,
        );
      }
      const toChar = await tx.character.findUnique({
        where: { id: input.toCharacterId },
      });
      if (toChar === null) {
        throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `目标人物不存在：${input.toCharacterId}`);
      }

      // 条件展开：description / chapterId 是可选字段
      await createRelationEdge(tx, {
        fromCharacterId: input.fromCharacterId,
        toCharacterId: input.toCharacterId,
        type: input.type,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.chapterId !== undefined ? { chapterId: input.chapterId } : {}),
      });
    });
  }

  /**
   * 查询项目下所有人物关系
   *
   * 读操作降级：AGE 不可用时返回空数组（前端关系图显示空状态而非崩）
   *
   * @returns 关系列表；AGE 不可用时返回空数组
   */
  async findRelations(projectId: string): Promise<CharacterRelationInput[]> {
    // 获取项目下所有人物 ID（用于过滤关系，防止跨项目污染）
    const characters = await this.prisma.character.findMany({
      where: { projectId },
      select: { id: true },
    });
    const characterIds = new Set(characters.map((c) => c.id));

    // 项目下无人物时直接返回空（避免无意义 Cypher 查询）
    if (characterIds.size === 0) {
      return [];
    }

    // AGE 查询失败时降级为空数组（前端优雅降级，不抛错）
    try {
      type RelationRow = {
        from: string;
        to: string;
        type: string;
        description?: string;
      };
      const rows = await queryCypher<RelationRow>(
        this.prisma,
        `MATCH (a:Character)-[r:RELATION]->(b:Character)
         RETURN a.characterId AS from, b.characterId AS to, r.type AS type, r.description AS description`,
      );

      // 过滤到本项目人物（from/to 都在项目内）
      return rows
        .filter((row) => characterIds.has(row.from) && characterIds.has(row.to))
        .map((row) => ({
          fromCharacterId: row.from,
          toCharacterId: row.to,
          type: row.type,
          ...(row.description !== undefined ? { description: row.description } : {}),
        }));
    } catch (err) {
      logger.warn(
        { projectId, error: err instanceof Error ? err.message : String(err) },
        'AGE 关系查询失败，降级为空数组',
      );
      return [];
    }
  }
}

/**
 * 序列化 Prisma Character 记录为 IPC 兼容的 Character 类型
 *
 * - Date 字段转 ISO 字符串
 * - null 保持 null（avatar/description 可空字段保留显式空值语义）
 * - profile 从 Prisma JsonValue 转为 Record<string, unknown>
 */
function serializeCharacter(raw: RawCharacter): Character {
  return {
    id: raw.id,
    projectId: raw.projectId,
    name: raw.name,
    avatar: raw.avatar,
    role: raw.role as Character['role'],
    description: raw.description,
    profile: raw.profile as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/** Prisma character.findUnique / findMany 返回的原始类型（NonNullable 去除 null 分支） */
type RawCharacter = NonNullable<Awaited<ReturnType<PrismaClient['character']['findUnique']>>>;
