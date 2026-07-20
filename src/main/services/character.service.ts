// src/main/services/character.service.ts
// 人物业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Character 模型 / §6.3 AGE 图
//
// 职责：
// 1. 人物 CRUD 编排（委托给 CharacterRepository）
// 2. 人物关系管理（委托给 CharacterRepository）
// 3. 仅负责日志与 IPC 错误码翻译，不直接访问 Prisma / AGE
//
// 架构原则（设计文档 §4.3 Repository 模式）：
// - service 层只依赖 Repository，不直接调用 PrismaClient / age.ts
// - 双存储一致性（Prisma + AGE）由 Repository 保证，事务边界在 Repository 内
// - AGE 失败降级策略由 Repository 决定（§6.5 容错降级）
// - service 关注业务编排与日志，Repository 关注持久化细节
//
// 注意：
// - 每次调用创建新 Repository 实例（Repository 无状态，避免跨调用状态泄漏）
// - 保持原 service 函数签名（IPC handler 无需改动）

import type {
  Character,
  CharacterCreateInput,
  CharacterRelationInput,
  CharacterUpdateInput,
} from '@novel-writer/shared';
import { getPrismaClient } from '../infra/prisma/client';
import { CharacterRepository } from '../infra/repositories/character.repository';
import { logger } from '../utils/logger';

/**
 * 获取人物领域 Repository 实例
 *
 * 每次调用创建新实例：Repository 无状态，新实例避免潜在的状态泄漏
 */
function getCharacterRepository(): CharacterRepository {
  return new CharacterRepository(getPrismaClient());
}

/**
 * 创建人物
 *
 * 同步在 AGE 图中创建 Character 顶点（Repository 内部处理 AGE 失败降级）
 *
 * @param input 人物创建入参（projectId / name 必填，其余可选）
 * @returns 创建后的人物（含自动生成的 id 与时间戳）
 */
export async function createCharacter(input: CharacterCreateInput): Promise<Character> {
  logger.info({ projectId: input.projectId, name: input.name }, '创建人物');
  return getCharacterRepository().create(input);
}

/**
 * 列出项目下所有人物（按 createdAt 升序）
 *
 * @param projectId 项目 ID
 * @returns 人物数组
 */
export async function listCharacters(projectId: string): Promise<Character[]> {
  return getCharacterRepository().listByProject(projectId);
}

/**
 * 更新人物字段
 *
 * 更新 name/role 时由 Repository 同步更新 AGE 顶点（事务包裹"删旧+建新"）
 *
 * @param input 更新入参（id 必填，其余至少 1 个字段）
 * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
 */
export async function updateCharacter(input: CharacterUpdateInput): Promise<Character> {
  logger.info({ characterId: input.id }, '更新人物');
  return getCharacterRepository().update(input);
}

/**
 * 删除人物
 *
 * 同步清理 AGE 顶点与关联边（Repository 内部处理 AGE 失败降级）
 *
 * @param id 人物 ID
 * @throws AppError(CHARACTER_NOT_FOUND) 人物不存在
 */
export async function deleteCharacter(id: string): Promise<{ id: string }> {
  await getCharacterRepository().delete(id);
  logger.info({ characterId: id }, '删除人物');
  return { id };
}

/**
 * 添加人物关系（AGE 图边）
 *
 * 由 Repository 在事务内校验两端人物存在 + 创建图边
 *
 * @param input 关系入参（from/to 必填，自环校验由 Zod schema 完成）
 * @returns 原样返回入参（确认关系已建立）
 * @throws AppError(CHARACTER_NOT_FOUND) from/to 人物不存在
 */
export async function addCharacterRelation(
  input: CharacterRelationInput,
): Promise<CharacterRelationInput> {
  await getCharacterRepository().addRelation(input);
  logger.info(
    { from: input.fromCharacterId, to: input.toCharacterId, type: input.type },
    '添加人物关系',
  );
  return input;
}

/**
 * 获取项目下所有人物关系
 *
 * AGE 不可用时由 Repository 降级返回空数组（前端关系图显示空状态而非崩）
 *
 * @param projectId 项目 ID
 * @returns 关系列表；AGE 不可用时返回空数组
 */
export async function getCharacterRelations(projectId: string): Promise<CharacterRelationInput[]> {
  return getCharacterRepository().findRelations(projectId);
}
