// packages/shared/src/schemas/character.schema.ts
// Character 实体 + 关系 Zod schema
// 字段来源：设计文档 §6.2 Prisma Character 模型 + §6.3 AGE 图边

import { z } from 'zod';
import { CharacterRole } from '../types/enums';

/** Character 实体 schema */
export const CharacterSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  avatar: z.string().nullable().optional(),
  role: z.enum([
    CharacterRole.PROTAGONIST,
    CharacterRole.ANTAGONIST,
    CharacterRole.SUPPORTING,
    CharacterRole.MINOR,
  ]),
  description: z.string().nullable().optional(),
  profile: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Character = z.infer<typeof CharacterSchema>;

/** 创建人物入参（role 缺省为 SUPPORTING） */
export const CharacterCreateInputSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1).max(100),
  avatar: z.string().optional(),
  role: z
    .enum([
      CharacterRole.PROTAGONIST,
      CharacterRole.ANTAGONIST,
      CharacterRole.SUPPORTING,
      CharacterRole.MINOR,
    ])
    .default(CharacterRole.SUPPORTING),
  description: z.string().optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
});
export type CharacterCreateInput = z.infer<typeof CharacterCreateInputSchema>;

/** 更新人物入参 */
export const CharacterUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(100).optional(),
    avatar: z.string().nullable().optional(),
    role: z
      .enum([
        CharacterRole.PROTAGONIST,
        CharacterRole.ANTAGONIST,
        CharacterRole.SUPPORTING,
        CharacterRole.MINOR,
      ])
      .optional(),
    description: z.string().nullable().optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type CharacterUpdateInput = z.infer<typeof CharacterUpdateInputSchema>;

/**
 * 人物关系入参（AGE 图边）
 *
 * 自环关系（from == to）应拒绝，避免循环引用
 */
export const CharacterRelationInputSchema = z
  .object({
    fromCharacterId: z.string().min(1),
    toCharacterId: z.string().min(1),
    type: z.string().min(1).max(50),
    description: z.string().optional(),
    chapterId: z.string().optional(),
  })
  .refine((data) => data.fromCharacterId !== data.toCharacterId, {
    message: '人物关系不能自环（from 和 to 不能相同）',
    path: ['toCharacterId'],
  });
export type CharacterRelationInput = z.infer<typeof CharacterRelationInputSchema>;
