// src/main/ipc/handlers/character.handler.ts
// 人物域 IPC handler（薄层）
// 设计文档 §4.1 分层架构：handler 只做参数校验 + 调 service
// §6.3 AGE 图：人物关系通过 addRelation/getRelations 维护
//
// 职责：
// 1. 注册 character 域 6 个 channel（create/list/update/delete/getRelations/addRelation）
// 2. 通过 wrap() 统一包装：sender 校验 + traceId + zod 校验 + 错误处理
// 3. addRelation 透传 CharacterRelationInput（schema 已校验自环关系）
//
// 注意：
// - handler 不持有状态，不直接访问 Prisma / AGE
// - getRelations 从 input 提取 projectId
// - addRelation 透传 input（CharacterRelationInputSchema 已校验）

import {
  CharacterCreateInputSchema,
  CharacterRelationInputSchema,
  CharacterUpdateInputSchema,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import { z } from 'zod';
import {
  addCharacterRelation,
  createCharacter,
  deleteCharacter,
  getCharacterRelations,
  listCharacters,
  updateCharacter,
} from '../../services/character.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 character 域 IPC handler
 *
 * 注册 6 个 channel：
 * - character:create       → createCharacter
 * - character:list         → listCharacters
 * - character:update       → updateCharacter
 * - character:delete       → deleteCharacter
 * - character:getRelations → getCharacterRelations
 * - character:addRelation  → addCharacterRelation
 */
export function registerCharacterHandlers(): void {
  // 创建人物：透传 input（CharacterCreateInputSchema 已校验）
  wrap(IPC_CHANNELS.CHARACTER_CREATE, CharacterCreateInputSchema, (input) =>
    createCharacter(input),
  );

  // 列出项目下人物：从 input 提取 projectId
  wrap(IPC_CHANNELS.CHARACTER_LIST, z.object({ projectId: z.string().min(1) }), (input) =>
    listCharacters(input.projectId),
  );

  // 更新人物：透传 input（CharacterUpdateInputSchema 已校验）
  wrap(IPC_CHANNELS.CHARACTER_UPDATE, CharacterUpdateInputSchema, (input) =>
    updateCharacter(input),
  );

  // 删除人物：从 input 提取 id
  wrap(IPC_CHANNELS.CHARACTER_DELETE, z.object({ id: z.string().min(1) }), (input) =>
    deleteCharacter(input.id),
  );

  // 获取人物关系列表：从 input 提取 projectId
  wrap(IPC_CHANNELS.CHARACTER_GET_RELATIONS, z.object({ projectId: z.string().min(1) }), (input) =>
    getCharacterRelations(input.projectId),
  );

  // 添加人物关系：透传 input（CharacterRelationInputSchema 已校验自环）
  wrap(IPC_CHANNELS.CHARACTER_ADD_RELATION, CharacterRelationInputSchema, (input) =>
    addCharacterRelation(input),
  );
}
