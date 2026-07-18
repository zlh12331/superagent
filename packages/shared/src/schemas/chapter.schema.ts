// packages/shared/src/schemas/chapter.schema.ts
// Chapter 实体 Zod schema + CRUD Input schema
// 字段来源：设计文档 §6.2 Prisma Chapter 模型

import { z } from 'zod';
import { ChapterStatus } from '../types/enums';

/** Chapter 实体 schema */
export const ChapterSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  volumeId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string(),
  wordCount: z.number().int().nonnegative(),
  status: z.enum([
    ChapterStatus.DRAFT,
    ChapterStatus.OUTLINE,
    ChapterStatus.WRITING,
    ChapterStatus.COMPLETED,
    ChapterStatus.REVISION,
  ]),
  sortOrder: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Chapter = z.infer<typeof ChapterSchema>;

/** 创建章节入参（content 默认空，status 默认 DRAFT，sortOrder 默认 0） */
export const ChapterCreateInputSchema = z.object({
  projectId: z.string().min(1),
  volumeId: z.string().nullable().optional(),
  title: z.string().min(1).max(200),
  content: z.string().default(''),
  status: z
    .enum([
      ChapterStatus.DRAFT,
      ChapterStatus.OUTLINE,
      ChapterStatus.WRITING,
      ChapterStatus.COMPLETED,
      ChapterStatus.REVISION,
    ])
    .default(ChapterStatus.DRAFT),
  sortOrder: z.number().int().nonnegative().default(0),
});
export type ChapterCreateInput = z.infer<typeof ChapterCreateInputSchema>;

/** 更新章节入参 */
export const ChapterUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(200).optional(),
    content: z.string().optional(),
    wordCount: z.number().int().nonnegative().optional(),
    status: z
      .enum([
        ChapterStatus.DRAFT,
        ChapterStatus.OUTLINE,
        ChapterStatus.WRITING,
        ChapterStatus.COMPLETED,
        ChapterStatus.REVISION,
      ])
      .optional(),
    sortOrder: z.number().int().nonnegative().optional(),
    volumeId: z.string().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type ChapterUpdateInput = z.infer<typeof ChapterUpdateInputSchema>;
