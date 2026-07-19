// src/main/ipc/handlers/chapter.handler.ts
// 章节域 IPC handler（薄层）
// 设计文档 §4.1 分层架构：handler 只做参数校验 + 调 service
//
// 职责：
// 1. 注册 chapter 域 6 个 channel（create/list/get/update/reorder/delete）
// 2. 通过 wrap() 统一包装：sender 校验 + traceId + zod 校验 + 错误处理
// 3. reorder 接收 { projectId, orderedIds }，调用 reorderChapters(projectId, orderedIds)
//
// 注意：
// - handler 不持有状态，不直接访问 Prisma
// - 简单入参（{ id } / { projectId }）使用内联 z.object schema
// - reorder 的 orderedIds 用 z.array(z.string().min(1)) 校验非空字符串数组

import {
  ChapterCreateInputSchema,
  ChapterUpdateInputSchema,
  IPC_CHANNELS,
} from '@novel-writer/shared';
import { z } from 'zod';
import {
  createChapter,
  deleteChapter,
  getChapter,
  listChapters,
  reorderChapters,
  updateChapter,
} from '../../services/chapter.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 chapter 域 IPC handler
 *
 * 注册 6 个 channel：
 * - chapter:create  → createChapter
 * - chapter:list    → listChapters
 * - chapter:get     → getChapter
 * - chapter:update  → updateChapter
 * - chapter:reorder → reorderChapters
 * - chapter:delete  → deleteChapter
 */
export function registerChapterHandlers(): void {
  // 创建章节：透传 input（ChapterCreateInputSchema 已校验）
  wrap(IPC_CHANNELS.CHAPTER_CREATE, ChapterCreateInputSchema, (input) => createChapter(input));

  // 列出项目下章节：从 input 提取 projectId
  wrap(IPC_CHANNELS.CHAPTER_LIST, z.object({ projectId: z.string().min(1) }), (input) =>
    listChapters(input.projectId),
  );

  // 获取单个章节：从 input 提取 id
  wrap(IPC_CHANNELS.CHAPTER_GET, z.object({ id: z.string().min(1) }), (input) =>
    getChapter(input.id),
  );

  // 更新章节：透传 input（ChapterUpdateInputSchema 已校验）
  wrap(IPC_CHANNELS.CHAPTER_UPDATE, ChapterUpdateInputSchema, (input) => updateChapter(input));

  // 批量重排章节顺序：从 input 提取 projectId + orderedIds
  wrap(
    IPC_CHANNELS.CHAPTER_REORDER,
    z.object({
      projectId: z.string().min(1),
      orderedIds: z.array(z.string().min(1)),
    }),
    (input) => reorderChapters(input.projectId, input.orderedIds),
  );

  // 删除章节：从 input 提取 id
  wrap(IPC_CHANNELS.CHAPTER_DELETE, z.object({ id: z.string().min(1) }), (input) =>
    deleteChapter(input.id),
  );
}
