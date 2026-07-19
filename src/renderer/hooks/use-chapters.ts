// src/renderer/hooks/use-chapters.ts
// 章节领域 hooks（CRUD + 拖拽排序）
// 设计文档 §5.1 数据流 + §6.2 Chapter 模型
//
// 职责：
// - useChapterList：按 projectId 获取章节列表
// - useChapterDetail：获取单个章节详情
// - useCreateChapter：新建章节
// - useUpdateChapter：更新章节（编辑器自动保存）
// - useReorderChapters：拖拽排序（批量更新 sortOrder）
// - useDeleteChapter：删除章节

import type { Chapter, ChapterCreateInput, ChapterUpdateInput } from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/**
 * 获取章节列表
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useChapterList(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: queryKeys.chapters.list(safeId),
    queryFn: async () => unwrap<Chapter[]>(await apiClient.chapter.list({ projectId: safeId })),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 获取章节详情
 *
 * @param id - 章节 ID（为 falsy 时不启用查询）
 */
export function useChapterDetail(id: string | null | undefined) {
  const safeId = id ?? '';
  return useQuery({
    queryKey: queryKeys.chapters.detail(safeId),
    queryFn: async () => unwrap<Chapter>(await apiClient.chapter.get({ id: safeId })),
    enabled: id !== undefined && id !== null && id.length > 0,
  });
}

/**
 * 新建章节
 *
 * 成功后失效章节列表缓存。
 */
export function useCreateChapter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChapterCreateInput) =>
      unwrap<Chapter>(await apiClient.chapter.create(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chapters.list(data.projectId) });
    },
  });
}

/**
 * 更新章节
 *
 * 用于编辑器自动保存（debounce 后调）。
 * 成功后仅失效章节详情（避免 invalidate list 导致重渲染闪烁）。
 */
export function useUpdateChapter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ChapterUpdateInput) =>
      unwrap<Chapter>(await apiClient.chapter.update(input)),
    onSuccess: (data) => {
      // 仅更新详情缓存，列表的 title/wordCount 在用户切换章节时刷新
      void qc.invalidateQueries({ queryKey: queryKeys.chapters.detail(data.id) });
    },
  });
}

/**
 * 拖拽排序
 *
 * 入参为 projectId + orderedIds（按新顺序排列的章节 ID 数组）。
 * 成功后失效章节列表缓存。
 */
export function useReorderChapters() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { projectId: string; orderedIds: string[] }) =>
      unwrap<{ id: string; sortOrder: number }[]>(await apiClient.chapter.reorder(params)),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: queryKeys.chapters.list(vars.projectId) });
    },
  });
}

/**
 * 删除章节
 *
 * 成功后失效章节列表，并清理被删章节的详情缓存。
 */
export function useDeleteChapter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap<{ id: string }>(await apiClient.chapter.delete({ id })),
    onSuccess: (data) => {
      // 失效所有章节列表（不确定 projectId，简化处理）
      void qc.invalidateQueries({ queryKey: queryKeys.chapters.all });
      void qc.removeQueries({ queryKey: queryKeys.chapters.detail(data.id) });
    },
  });
}
