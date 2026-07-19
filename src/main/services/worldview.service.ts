// src/main/services/worldview.service.ts
// 世界观业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 Worldview 模型（自关联树形）
//
// 职责：
// 1. 世界观 CRUD（create / tree / update / delete）
// 2. 树形查询（返回扁平数组，渲染层组装为树）
// 3. create 时校验 parentId 存在且同项目
//
// 注意：
// - delete 依赖 DB 层 onDelete: Cascade 自动级联删除子节点（无需 service 递归）
// - 不与其他 service 互相依赖
// - Prisma Date 字段在 service 边界序列化为 ISO 字符串（IPC 兼容）
// - exactOptionalPropertyTypes: true 下，create 用条件展开、update 过滤 undefined

import {
  AppError,
  ErrorCode,
  type Worldview,
  type WorldviewCreateInput,
  type WorldviewUpdateInput,
} from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { logger } from '../utils/logger';

/**
 * 创建世界观条目
 *
 * 传入 parentId 时校验父节点存在且属于同一项目（防止跨项目引用）
 *
 * @param input 创建入参（projectId / title 必填，其余可选）
 * @returns 创建后的世界观条目（含自动生成的 id 与时间戳）
 */
export async function createWorldview(input: WorldviewCreateInput): Promise<Worldview> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId, title: input.title }, '创建世界观条目');

  // 校验 parentId（若传入 null 或 undefined 则跳过，视为根节点）
  if (input.parentId !== null && input.parentId !== undefined) {
    const parent = await prisma.worldview.findUnique({
      where: { id: input.parentId },
    });
    // 父节点必须存在且属于同一项目（防止跨项目引用）
    if (parent === null || parent.projectId !== input.projectId) {
      throw new AppError(ErrorCode.NOT_FOUND, `父节点不存在或不属于同一项目：${input.parentId}`);
    }
  }

  // 条件展开：仅在字段定义时传入（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  // parentId 用 ?? null 转换 undefined 为 null（Prisma parentId 字段为 String?）
  // sortOrder 用 ?? 0 兜底默认值（zod schema 已声明 .default(0)，但 service 收到的 input 可能未经过 zod parse）
  const created = await prisma.worldview.create({
    data: {
      projectId: input.projectId,
      parentId: input.parentId ?? null,
      title: input.title,
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      sortOrder: input.sortOrder ?? 0,
    },
  });

  return serializeWorldview(created);
}

/**
 * 获取项目下所有世界观条目（扁平数组）
 *
 * 渲染层根据 parentId 组装为树形结构
 * 排序：sortOrder 升序
 *
 * @param projectId 项目 ID
 * @returns 世界观条目数组（扁平）
 */
export async function getWorldviewTree(projectId: string): Promise<Worldview[]> {
  const prisma = getPrismaClient();
  const items = await prisma.worldview.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  });
  return items.map(serializeWorldview);
}

/**
 * 更新世界观条目字段
 *
 * @param input 更新入参（id 必填，其余至少 1 个字段）
 * @throws AppError(NOT_FOUND) 条目不存在
 */
export async function updateWorldview(input: WorldviewUpdateInput): Promise<Worldview> {
  const prisma = getPrismaClient();

  // 先检查存在（提供更友好的错误码）
  const existing = await prisma.worldview.findUnique({ where: { id: input.id } });
  if (existing === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `世界观条目不存在：${input.id}`);
  }

  // 提取除 id 之外的更新字段
  const { id: _id, ...updateData } = input;
  // 过滤 undefined 值（exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
  // 注意：null 是有效值（用于清空字段），不能过滤
  const updatePayload = Object.fromEntries(
    Object.entries(updateData).filter(([, value]) => value !== undefined),
  ) as never;
  const updated = await prisma.worldview.update({
    where: { id: input.id },
    data: updatePayload,
  });

  logger.info({ worldviewId: input.id }, '更新世界观条目');
  return serializeWorldview(updated);
}

/**
 * 删除世界观条目
 *
 * DB 层 onDelete: Cascade 自动级联删除所有子节点（无需 service 显式递归）
 *
 * @param id 世界观条目 ID
 * @throws AppError(NOT_FOUND) 条目不存在
 */
export async function deleteWorldview(id: string): Promise<{ id: string }> {
  const prisma = getPrismaClient();

  const existing = await prisma.worldview.findUnique({ where: { id } });
  if (existing === null) {
    throw new AppError(ErrorCode.NOT_FOUND, `世界观条目不存在：${id}`);
  }

  await prisma.worldview.delete({ where: { id } });
  logger.info({ worldviewId: id }, '删除世界观条目（含子节点级联）');
  return { id };
}

/**
 * 序列化 Prisma Worldview 记录为 IPC 兼容的 Worldview 类型
 *
 * - Date 字段转 ISO 字符串
 * - null 保持 null（不转 undefined，保留显式空值语义）
 */
function serializeWorldview(raw: RawWorldview): Worldview {
  return {
    id: raw.id,
    projectId: raw.projectId,
    parentId: raw.parentId,
    title: raw.title,
    content: raw.content,
    type: raw.type,
    icon: raw.icon,
    sortOrder: raw.sortOrder,
    createdAt: raw.createdAt.toISOString(),
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/** Prisma worldview.findUnique 返回的原始类型（findUnique 可返回 null，用 NonNullable 包裹） */
type RawWorldview = NonNullable<Awaited<ReturnType<PrismaClient['worldview']['findUnique']>>>;
