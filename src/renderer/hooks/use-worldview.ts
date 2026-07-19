// src/renderer/hooks/use-worldview.ts
// 世界观领域 hooks（CRUD + 树查询）
// 设计文档 §5.1 数据流 + §6.2 Worldview 自关联树形
//
// 职责：
// - useWorldviewTree：按 projectId 获取整棵世界观树（扁平数组，UI 端递归构造）
// - useCreateWorldview：新建节点
// - useUpdateWorldview：更新节点
// - useDeleteWorldview：删除节点

import type { Worldview, WorldviewCreateInput, WorldviewUpdateInput } from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/**
 * 获取世界观树
 *
 * 后端返回扁平数组（含 parentId），UI 端递归构造为树形结构。
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useWorldviewTree(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: queryKeys.worldviews.tree(safeId),
    queryFn: async () => unwrap<Worldview[]>(await apiClient.worldview.tree({ projectId: safeId })),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 新建世界观节点
 *
 * 成功后失效该项目的整棵树缓存。
 */
export function useCreateWorldview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WorldviewCreateInput) =>
      unwrap<Worldview>(await apiClient.worldview.create(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.worldviews.tree(data.projectId) });
    },
  });
}

/**
 * 更新世界观节点
 *
 * 成功后失效该项目的整棵树缓存。
 */
export function useUpdateWorldview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: WorldviewUpdateInput) =>
      unwrap<Worldview>(await apiClient.worldview.update(input)),
    onSuccess: (_data) => {
      // 简化处理：失效所有 worldview 缓存（无法从 input 拿 projectId）
      void qc.invalidateQueries({ queryKey: queryKeys.worldviews.all });
    },
  });
}

/**
 * 删除世界观节点
 *
 * 成功后失效所有 worldview 缓存（节点删除可能影响多个 parentId 引用）。
 */
export function useDeleteWorldview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      unwrap<{ id: string }>(await apiClient.worldview.delete({ id })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: queryKeys.worldviews.all });
    },
  });
}
