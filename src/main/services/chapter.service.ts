// src/main/services/chapter.service.ts
// 章节业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Chapter 模型
//
// 职责：
// 1. 章节 CRUD（create / list / get / update / delete）
// 2. 章节排序（reorder，事务批量更新）
// 3. wordCount 自动计算（content.length）
//
// 注意：
// - 不与其他 service 互相依赖
// - reorder 使用 $transaction 保证原子性
// - Prisma Date 字段在 service 边界序列化为 ISO 字符串（IPC 兼容）

import {
  AppError,
  type Chapter,
  type ChapterCreateInput,
  type ChapterUpdateInput,
  ErrorCode,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建章节
 *
 * wordCount 自动从 content.length 计算（中文按字符数）
 *
 * @param input 章节创建入参（projectId / title 必填，其余可选）
 * @returns 创建后的章节（含自动生成的 id 与时间戳）
 */
export async function createChapter(input: ChapterCreateInput): Promise<Chapter> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title }, '创建章节');

  // 条件展开：仅在 volumeId 定义时传入（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  // volumeId 可为 string 或 null（显式解绑卷宗），undefined 表示未传入（使用 DB 默认 null）
  const created = await prisma.chapter.create({
    data: {
      projectId: input.projectId,
      ...(input.volumeId !== undefined ? { volumeId: input.volumeId } : {}),
      title: input.title,
      content: input.content,
      status: input.status,
      sortOrder: input.sortOrder,
      wordCount: input.content.length,
      metadata: {},
    },
  });

  return serializeChapter(created);
}

/**
 * 列出项目下所有章节（按 sortOrder 升序）
 *
 * @param projectId 项目 ID
 * @returns 章节数组
 */
export async function listChapters(projectId: string): Promise<Chapter[]> {
  const prisma = getPrismaClient();
  const chapters = await prisma.chapter.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  });
  return chapters.map(serializeChapter);
}

/**
 * 获取单个章节
 *
 * @param id 章节 ID
 * @throws AppError(CHAPTER_NOT_FOUND) 章节不存在
 */
export async function getChapter(id: string): Promise<Chapter> {
  const prisma = getPrismaClient();
  const found = await prisma.chapter.findUnique({ where: { id } });
  if (found === null) {
    throw new AppError(ErrorCode.CHAPTER_NOT_FOUND, `章节不存在：${id}`);
  }
  return serializeChapter(found);
}

/**
 * 更新章节字段
 *
 * 若 content 被更新且未显式传 wordCount，自动重算 wordCount = content.length
 *
 * @param input 更新入参（id 必填，其余至少 1 个字段）
 * @throws AppError(CHAPTER_NOT_FOUND) 章节不存在
 */
export async function updateChapter(input: ChapterUpdateInput): Promise<Chapter> {
  const prisma = getPrismaClient();

  // 先检查存在（提供更友好的错误码）
  const existing = await prisma.chapter.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHAPTER_NOT_FOUND, `章节不存在：${input.id}`);
  }

  // 提取除 id 之外的更新字段
  const { id: _id, ...updateData } = input;

  // content 被更新时自动重算 wordCount（除非显式传 wordCount）
  if (input.content !== undefined && input.wordCount === undefined) {
    updateData.wordCount = input.content.length;
  }

  // 过滤 undefined 值（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  // 注意：null 值保留（volumeId: null 表示显式解绑卷宗）
  const updatePayload = Object.fromEntries(
    Object.entries(updateData).filter(([, value]) => value !== undefined),
  ) as never;

  const updated = await prisma.chapter.update({
    where: { id: input.id },
    data: updatePayload,
  });

  logger.info({ chapterId: input.id }, '更新章节');
  return serializeChapter(updated);
}

/**
 * 批量重排章节顺序（事务原子性）
 *
 * @param projectId 项目 ID（用于日志，不参与 where 过滤，调用方负责传入正确项目）
 * @param orderedIds 按新顺序排列的章节 ID 数组
 * @returns 更新后的 id + sortOrder 列表（与 orderedIds 顺序一致）
 */
export async function reorderChapters(
  projectId: string,
  orderedIds: string[],
): Promise<{ id: string; sortOrder: number }[]> {
  const prisma = getPrismaClient();
  logger.info({ projectId, count: orderedIds.length }, '重排章节顺序');

  // $transaction 数组形式：所有 update 原子提交，任一失败全部回滚
  const result = await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.chapter.update({
        where: { id },
        data: { sortOrder: index },
        select: { id: true, sortOrder: true },
      }),
    ),
  );

  return result.map((r) => ({ id: r.id, sortOrder: r.sortOrder }));
}

/**
 * 删除章节
 *
 * @param id 章节 ID
 * @throws AppError(CHAPTER_NOT_FOUND) 章节不存在
 */
export async function deleteChapter(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.chapter.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.CHAPTER_NOT_FOUND, `章节不存在：${id}`);
  }

  await prisma.chapter.delete({ where: { id } });
  logger.info({ chapterId: id }, '删除章节');
  return { id };
}

/**
 * 序列化 Prisma Chapter 记录为 IPC 兼容的 Chapter 类型
 *
 * - Date 字段转 ISO 字符串
 * - null 保持 null（volumeId 可为 null 表示无关联卷宗）
 */
function serializeChapter(raw: RawChapter): Chapter {
  return {
    id: raw.id,
    projectId: raw.projectId,
    volumeId: raw.volumeId,
    title: raw.title,
    content: raw.content,
    wordCount: raw.wordCount,
    status: raw.status as Chapter['status'],
    sortOrder: raw.sortOrder,
    metadata: raw.metadata as Record<string, unknown>,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/** Prisma chapter.findUnique 返回的原始类型（NonNullable 去除 null 简化字段访问） */
type RawChapter = NonNullable<Awaited<ReturnType<PrismaClient['chapter']['findUnique']>>>;
