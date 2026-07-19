// src/renderer/hooks/use-settings.ts
// 设置领域 hooks（项目级 + 全局 API Key）
// 设计文档 §5.1 数据流 + §7.7 应用设置
//
// 职责：
// - useProjectSettings：按 projectId 获取项目设置
// - useUpdateProjectSettings：更新项目设置
// - useSetApiKey：保存 API Key（写入 keychain）
// - useTestApiKey：测试 API Key 连通性

import type {
  ProjectSetting,
  ProjectSettingUpdateInput,
  TestApiKeyInput,
} from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { apiClient, unwrap } from '@/api/client';
import { queryKeys } from '@/api/query-keys';

/**
 * 获取项目设置
 *
 * @param projectId - 项目 ID（为 falsy 时不启用查询）
 */
export function useProjectSettings(projectId: string | null | undefined) {
  const safeId = projectId ?? '';
  return useQuery({
    queryKey: queryKeys.settings.detail(safeId),
    queryFn: async () =>
      unwrap<ProjectSetting>(await apiClient.settings.get({ projectId: safeId })),
    enabled: projectId !== undefined && projectId !== null && projectId.length > 0,
  });
}

/**
 * 更新项目设置
 *
 * 成功后失效该项目设置缓存。
 */
export function useUpdateProjectSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: ProjectSettingUpdateInput) =>
      unwrap<ProjectSetting>(await apiClient.settings.set(input)),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: queryKeys.settings.detail(data.projectId) });
    },
  });
}

/**
 * 保存 API Key 到 keychain
 *
 * 入参 provider 决定写入 deepseek 还是 ollama 的 key。
 */
export function useSetApiKey() {
  return useMutation({
    mutationFn: async (input: { provider: 'deepseek' | 'ollama'; apiKey: string }) =>
      unwrap<{ ok: boolean }>(await apiClient.settings.setApiKey(input)),
  });
}

/**
 * 测试 API Key 连通性
 *
 * 不携带 key 本身（key 已存 keychain，主进程从 keychain 读取）。
 * 返回 ok 与 latencyMs（成功时延迟毫秒数）。
 */
export function useTestApiKey() {
  return useMutation({
    mutationFn: async (input: TestApiKeyInput) =>
      unwrap<{ ok: boolean; latencyMs?: number }>(await apiClient.settings.testApiKey(input)),
  });
}
