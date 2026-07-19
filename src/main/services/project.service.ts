// src/main/services/project.service.ts
// 项目业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Project 模型
//
// 职责：
// 1. 项目 CRUD（create / list / get / update / delete）
// 2. 项目归档（archive）
// 3. 错误统一通过 AppError 抛出
//
// 注意：
// - 不持有状态，通过 getPrismaClient() 单例访问数据库
// - 不与其他 service 互相依赖（设计文档 §4.4 禁止依赖方向）
// - Prisma Date 字段在 service 边界序列化为 ISO 字符串（IPC 兼容）

import {
  AppError,
  ErrorCode,
  type Project,
  type ProjectCreateInput,
  ProjectStatus,
  type ProjectUpdateInput,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建项目
 *
 * @param input 项目创建入参（name 必填，其余可选）
 * @returns 创建后的项目（含自动生成的 id 与时间戳）
 */
export async function createProject(input: ProjectCreateInput): Promise<Project> {
  const prisma = getPrismaClient();
  logger.info({ name: input.name }, '创建项目');

  // 条件展开：仅在字段定义时传入（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  const created = await prisma.project.create({
    data: {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.genre !== undefined ? { genre: input.genre } : {}),
      ...(input.cover !== undefined ? { cover: input.cover } : {}),
    },
  });

  return serializeProject(created);
}

/**
 * 列出所有未归档的项目
 *
 * 排序：archivedAt（NULL 优先）+ updatedAt 倒序
 *
 * @returns 项目数组
 */
export async function listProjects(): Promise<Project[]> {
  const prisma = getPrismaClient();
  const projects = await prisma.project.findMany({
    where: { archivedAt: null },
    orderBy: [{ archivedAt: 'asc' }, { updatedAt: 'desc' }],
  });
  return projects.map(serializeProject);
}

/**
 * 获取单个项目
 *
 * @param id 项目 ID
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function getProject(id: string): Promise<Project> {
  const prisma = getPrismaClient();
  const found = await prisma.project.findUnique({ where: { id } });
  if (found === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${id}`);
  }
  return serializeProject(found);
}

/**
 * 更新项目字段
 *
 * @param input 更新入参（id 必填，其余至少 1 个字段）
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function updateProject(input: ProjectUpdateInput): Promise<Project> {
  const prisma = getPrismaClient();

  // 先检查存在（提供更友好的错误码）
  const existing = await prisma.project.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${input.id}`);
  }

  // 提取除 id 之外的更新字段
  const { id: _id, ...updateData } = input;
  // 过滤 undefined 值（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  const updatePayload = Object.fromEntries(
    Object.entries(updateData).filter(([, value]) => value !== undefined),
  ) as never;
  const updated = await prisma.project.update({
    where: { id: input.id },
    data: updatePayload,
  });

  logger.info({ projectId: input.id }, '更新项目');
  return serializeProject(updated);
}

/**
 * 删除项目（硬删除，级联删除所有子表）
 *
 * @param id 项目 ID
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function deleteProject(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.project.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${id}`);
  }

  await prisma.project.delete({ where: { id } });
  logger.info({ projectId: id }, '删除项目');
  return { id };
}

/**
 * 归档项目（标记为 ARCHIVED 并记录归档时间）
 *
 * @param id 项目 ID
 * @throws AppError(PROJECT_NOT_FOUND) 项目不存在
 */
export async function archiveProject(id: string): Promise<Project> {
  const prisma = getPrismaClient();

  const existing = await prisma.project.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.PROJECT_NOT_FOUND, `项目不存在：${id}`);
  }

  const updated = await prisma.project.update({
    where: { id },
    data: {
      status: ProjectStatus.ARCHIVED,
      archivedAt: new Date(),
    },
  });

  logger.info({ projectId: id }, '归档项目');
  return serializeProject(updated);
}

/**
 * 序列化 Prisma Project 记录为 IPC 兼容的 Project 类型
 *
 * - Date 字段转 ISO 字符串
 * - null 保持 null（不转 undefined，保留显式空值语义）
 */
function serializeProject(raw: RawProject): Project {
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    genre: raw.genre,
    cover: raw.cover,
    status: raw.status as Project['status'],
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
    archivedAt: raw.archivedAt === null ? null : raw.archivedAt.toISOString(),
  };
}

/** Prisma project.findUnique / findMany 返回的原始类型 */
type RawProject = NonNullable<Awaited<ReturnType<PrismaClient['project']['findUnique']>>>;
