// src/renderer/hooks/use-projects.ts
// 项目领域 hooks（CRUD + 归档 + 删除）
// 设计文档 §5.1 数据流：query + mutation + invalidate
//
// 职责：
// - useProjectList：获取项目列表（queryKeys.projects.list()）
// - useProjectDetail：获取单个项目详情
// - useCreateProject：新建项目（成功后失效列表）
// - useUpdateProject：更新项目（成功后失效列表 + 详情）
// - useArchiveProject：归档项目（成功后失效列表）
// - useDeleteProject：删除项目（成功后失效列表）
//
// 所有 mutation 默认 onError 由 useIpcMutation 内部调 handleIpcError 显示 toast，
// 调用方只需提供 onSuccess 用于失效缓存。

import type { Project, ProjectCreateInput, ProjectUpdateInput } from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/**
 * 获取项目列表
 *
 * @example
 * const { data, isLoading, error } = useProjectList();
 */
export function useProjectList() {
  return useQuery({
    queryKey: queryKeys.projects.list(),
    queryFn: async () => unwrap<Project[]>(await apiClient.project.list()),
  });
}

/**
 * 获取项目详情
 *
 * @param id - 项目 ID（为 falsy 时不启用查询）
 */
export function useProjectDetail(id: string | null | undefined) {
  // queryKey 永远是同一形状（避免 null/undefined 触发不同 key 导致缓存丢失）
  // enabled 控制是否实际发起查询
  const safeId = id ?? '';
  return useQuery({
    queryKey: queryKeys.projects.detail(safeId),
    queryFn: async () => unwrap<Project>(await apiClient.project.get({ id: safeId })),
    enabled: id !== undefined && id !== null && id.length > 0,
  });
}

/**
 * 新建项目
 *
 * 成功后失效项目列表缓存（让列表自动刷新）。
 */
export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectCreateInput) =>
      unwrap<Project>(await apiClient.project.create(input)),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

/**
 * 更新项目
 *
 * 成功后失效项目列表与该项目详情缓存。
 */
export function useUpdateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectUpdateInput) =>
      unwrap<Project>(await apiClient.project.update(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      void qc.invalidateQueries({ queryKey: queryKeys.projects.detail(data.id) });
    },
  });
}

/**
 * 归档项目
 *
 * 成功后失效项目列表（归档项目状态会变化）。
 */
export function useArchiveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => unwrap<Project>(await apiClient.project.archive({ id })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all });
    },
  });
}

/**
 * 删除项目
 *
 * 成功后失效项目列表，并清理被删项目的详情缓存。
 */
export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap<{ id: string }>(await apiClient.project.delete({ id })),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.projects.all });
      void qc.removeQueries({ queryKey: queryKeys.projects.detail(data.id) });
    },
  });
}
