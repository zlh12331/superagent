// packages/shared/src/schemas/project.schema.ts
// Project 实体 Zod schema + CRUD Input schema
// 实体字段来源：设计文档 §6.2 Prisma Project 模型
// Zod 4 最佳实践：schema 同时承担运行时校验与类型派生（z.infer）

import { z } from 'zod';
import { ProjectStatus } from '../types/enums';

/**
 * Project 实体 schema（对应数据库已存在记录）
 *
 * 字段对齐设计文档 §6.2 Prisma Project 模型
 * - name: 1-200 字符
 * - status: 枚举
 * - metadata: JSON 对象（默认 {}）
 * - 时间戳为 ISO 8601 字符串（Prisma DateTime 序列化后）
 */
export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  genre: z.string().max(50).nullable().optional(),
  cover: z.string().nullable().optional(),
  status: z.enum([ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED, ProjectStatus.DRAFT]),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  archivedAt: z.string().nullable().optional(),
});

/** Project 实体类型（从 schema 派生，避免类型与校验分离） */
export type Project = z.infer<typeof ProjectSchema>;

/**
 * 创建项目入参
 *
 * 仅 name 必填，其余可选
 * name 会 trim 后校验非空
 */
export const ProjectCreateInputSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(200)
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, { message: 'name 不能为空白' }),
  description: z.string().optional(),
  genre: z.string().max(50).optional(),
  cover: z.string().optional(),
});
export type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;

/**
 * 更新项目入参
 *
 * id 必填（定位记录），其余字段至少传 1 个
 * 使用 .refine 强制 partial 非空
 */
export const ProjectUpdateInputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).max(200).optional(),
    description: z.string().nullable().optional(),
    genre: z.string().max(50).nullable().optional(),
    cover: z.string().nullable().optional(),
    status: z.enum([ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED, ProjectStatus.DRAFT]).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((data) => Object.keys(data).length > 1, {
    message: '至少需要更新 1 个字段（除 id 外）',
  });
export type ProjectUpdateInput = z.infer<typeof ProjectUpdateInputSchema>;
