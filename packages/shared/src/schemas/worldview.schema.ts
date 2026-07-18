// packages/shared/src/schemas/worldview.schema.ts
// Worldview（世界观条目，自关联树形）Zod schema
// 字段来源：设计文档 §6.2 Prisma Worldview 模型

import { z } from 'zod';

/** Worldview 实体 schema */
export const WorldviewSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string().nullable().optional(),
  type: z.string().max(50).nullable().optional(),
  icon: z.string().nullable().optional(),
  sortOrder: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Worldview = z.infer<typeof WorldviewSchema>;

/** 创建世界观条目入参 */
export const WorldviewCreateInputSchema = z.object({
  projectId: z.string().min(1),
  parentId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string().optional(),
  type: z.string().max(50).optional(),
  icon: z.string().optional(),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type WorldviewCreateInput = z.infer<typeof WorldviewCreateInputSchema>;

/** 更新世界观条目入参 */
export const WorldviewUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    content: z.string().nullable().optional(),
    type: z.string().max(50).nullable().optional(),
    icon: z.string().nullable().optional(),
    sortOrder: z.number().int().nonnegative().optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type WorldviewUpdateInput = z.infer<typeof WorldviewUpdateInputSchema>;
