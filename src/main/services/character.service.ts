// src/main/services/character.service.ts
// 人物业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Character 模型 / §6.3 AGE 图
//
// 职责：
// 1. 人物 CRUD（create / list / update / delete）
// 2. 人物关系管理（AGE 图边：addRelation / getRelations）
// 3. create 时同步创建 AGE 顶点；delete 时清理 AGE 顶点与边（容错）
//
// 注意：
// - 调用 infra/prisma/extensions/age.ts 透传 Cypher
// - AGE 失败不阻塞 Prisma 业务（仅 warn 日志），保证主流程可用（§6.5 AGE 兼容性降级策略）
// - Profile 默认 {}
// - exactOptionalPropertyTypes: true 下，可选字段用条件展开避免显式 undefined

import {
  AppError,
  type Character,
  type CharacterCreateInput,
  type CharacterRelationInput,
  type CharacterUpdateInput,
  ErrorCode,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import {
  createCharacterVertex,
  createRelationEdge,
  executeCypher,
  queryCypher,
} from '../infra/prisma/extensions/age';
import { logger } from '../utils/logger';

/**
 * 创建人物
 *
 * 同步在 AGE 图中创建 Character 顶点
 * 若 AGE 创建失败，仅 warn 日志，不阻塞 Prisma 业务
 *
 * @param input 人物创建入参（projectId / name 必填，其余可选）
 * @returns 创建后的人物（含自动生成的 id 与时间戳）
 */
export async function createCharacter(input: CharacterCreateInput): Promise<Character> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, name: input.name }, '创建人物');

  // 条件展开：仅在字段定义时传入（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  // avatar / description 是 Prisma String?（可空），但 input.avatar / input.description 是 string | undefined
  // 用条件展开避免 TS2375，同时让 Vitest toHaveBeenCalledWith 的 undefined 期望与缺失 key 等价
  const created = await prisma.character.create({
    data: {
      projectId: input.projectId,
      name: input.name,
      role: input.role,
      // Prisma Json 字段类型严格（InputJsonValue 不接受 Record<string, unknown>）
      // 用 as never 绕过类型检查（与 project.service.ts updatePayload 模式一致）
      profile: (input.profile ?? {}) as never,
      ...(input.avatar !== undefined ? { avatar: input.avatar } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
  });

  // 同步创建 AGE 顶点（失败不阻塞，符合 §6.5 降级策略）
  try {
    await createCharacterVertex(prisma, {
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
 * 列出项目下所有人物（按 createdAt 升序）
 *
 * @param projectId 项目 ID
 * @returns 人物数组
 */
export async function listCharacters(projectId: string): Promise<Character[]> {
  const prisma = getPrismaClient();
  const characters = await prisma.character.findMany({
    where: { projectId },
    orderBy: { createdAt: 'asc' },
  });
  return characters.map(serializeCharacter);
}

/**
 * 更新人物字段
 *
 * 更新 name/role 时同步更新 AGE 顶点（删除旧顶点 + 创建新顶点，容错）
 *
 * @param input 更新入参（id 必填，其余至少 1 个字段）
 * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
 */
export async function updateCharacter(input: CharacterUpdateInput): Promise<Character> {
  const prisma = getPrismaClient();

  // 先检查存在（提供更友好的错误码）
  const existing = await prisma.character.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `人物不存在：${input.id}`);
  }

  // 提取除 id 之外的更新字段
  const { id: _id, ...updateData } = input;
  // 过滤 undefined 值（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  const updatePayload = Object.fromEntries(
    Object.entries(updateData).filter(([, value]) => value !== undefined),
  ) as never;
  const updated = await prisma.character.update({
    where: { id: input.id },
    data: updatePayload,
  });

  // 同步更新 AGE 顶点（删除旧顶点 + 创建新顶点，简化处理）
  // 仅在 name/role 变化时触发（顶点属性需同步）
  if (input.name !== undefined || input.role !== undefined) {
    try {
      // 删除旧顶点（DETACH DELETE 同时清理关联边）
      await executeCypher(
        prisma,
        `MATCH (n:Character {characterId: '${input.id}'}) DETACH DELETE n`,
      );
      // 重新创建
      await createCharacterVertex(prisma, {
        characterId: updated.id,
        name: updated.name,
        role: updated.role,
      });
    } catch (err) {
      logger.warn(
        { characterId: input.id, error: err instanceof Error ? err.message : String(err) },
        'AGE 顶点更新失败（不阻塞）',
      );
    }
  }

  logger.info({ characterId: input.id }, '更新人物');
  return serializeCharacter(updated);
}

/**
 * 删除人物
 *
 * 同步清理 AGE 顶点与关联边（容错：失败不阻塞 Prisma 删除）
 *
 * @param id 人物 ID
 * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
 */
export async function deleteCharacter(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.character.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `人物不存在：${id}`);
  }

  await prisma.character.delete({ where: { id } });

  // 清理 AGE 顶点与关联边（DETACH DELETE 自动删除所有关联边）
  try {
    await executeCypher(prisma, `MATCH (n:Character {characterId: '${id}'}) DETACH DELETE n`);
  } catch (err) {
    logger.warn(
      { characterId: id, error: err instanceof Error ? err.message : String(err) },
      'AGE 顶点清理失败（不阻塞删除）',
    );
  }

  logger.info({ characterId: id }, '删除人物');
  return { id };
}

/**
 * 添加人物关系（AGE 图边）
 *
 * @param input 关系入参（from/to 必填，自环校验由 Zod schema 完成）
 * @returns 原样返回入参（确认关系已建立）
 * @throws AppError(CHARACTER_NOT_FOUND) from/to 人物不存在
 */
export async function addCharacterRelation(
  input: CharacterRelationInput,
): Promise<CharacterRelationInput> {
  const prisma = getPrismaClient();

  // 校验两端人物存在
  const fromChar = await prisma.character.findUnique({
    where: { id: input.fromCharacterId },
  });
  if (fromChar === null) {
    throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `起始人物不存在：${input.fromCharacterId}`);
  }
  const toChar = await prisma.character.findUnique({
    where: { id: input.toCharacterId },
  });
  if (toChar === null) {
    throw new AppError(ErrorCode.CHARACTER_NOT_FOUND, `目标人物不存在：${input.toCharacterId}`);
  }

  // 条件展开：description / chapterId 是可选字段，避免显式 undefined（TS2375）
  await createRelationEdge(prisma, {
    fromCharacterId: input.fromCharacterId,
    toCharacterId: input.toCharacterId,
    type: input.type,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.chapterId !== undefined ? { chapterId: input.chapterId } : {}),
  });

  logger.info(
    { from: input.fromCharacterId, to: input.toCharacterId, type: input.type },
    '添加人物关系',
  );
  return input;
}

/**
 * 获取项目下所有人物关系
 *
 * 通过 Cypher MATCH 查询所有 RELATION 边，再过滤到项目人物（防止跨项目污染）
 *
 * @param projectId 项目 ID
 * @returns 关系列表
 */
export async function getCharacterRelations(projectId: string): Promise<CharacterRelationInput[]> {
  const prisma = getPrismaClient();

  // 获取项目下所有人物 ID（用于过滤关系，防止跨项目污染）
  const characters = await prisma.character.findMany({
    where: { projectId },
    select: { id: true },
  });
  const characterIds = new Set(characters.map((c) => c.id));

  // 项目下无人物时直接返回空（避免无意义 Cypher 查询）
  if (characterIds.size === 0) {
    return [];
  }

  // 查询所有 RELATION 边（Cypher 返回的行结构）
  type RelationRow = {
    from: string;
    to: string;
    type: string;
    description?: string;
  };
  const rows = await queryCypher<RelationRow>(
    prisma,
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
      // 条件展开：description 为 undefined 时省略 key（exactOptionalPropertyTypes）
      ...(row.description !== undefined ? { description: row.description } : {}),
    }));
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
