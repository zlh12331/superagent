// src/renderer/hooks/use-api-key.ts
// API Key 管理 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 settings:getApiKey / setApiKey / deleteApiKey IPC
// - 主进程通过 safeStorage 加密存储（Windows DPAPI / macOS Keychain / Linux libsecret）
// - 提供查询 / 设置 / 删除 mutation，自动失效缓存
//
// 设计依据（项目规范）：
// - "Server state from IPC `invoke` (request-response) must use TanStack Query
//    for caching, invalidation, and race condition handling"
// - API Key 在主进程 keychain 加密存储，渲染层只读写明文
//
// 缓存策略：
// - queryKey: ['api-key', provider] - 按 provider 分桶
// - staleTime: Infinity（仅在显式 set/delete 后失效）
// - 不会自动 refetch（API Key 变更频率极低，无需轮询）
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { MODELS_QUERY_KEY } from './use-models';

/**
 * Query key 工厂（按 provider 分桶）
 *
 * ['api-key', provider] 唯一标识单个 provider 的 API Key 查询缓存。
 */
export const API_KEY_QUERY_KEY = (provider: ApiKeyProvider) => ['api-key', provider] as const;

/**
 * API Key 查询 hook
 *
 * 调用 settings:getApiKey IPC 查询指定 provider 的配置状态。
 * P0 安全修复：主进程只返回 { configured } 布尔，明文不回传渲染层。
 *
 * @param provider API 提供商标识（如 'deepseek'）
 * @returns TanStack Query 结果（data 为 boolean：true = 已配置）
 *
 * @example
 * ```tsx
 * const { data: configured, isLoading } = useApiKeyQuery('deepseek');
 * if (isLoading) return <Loading />;
 * return configured ? <Badge>已配置</Badge> : <Button>设置 API Key</Button>;
 * ```
 */
export function useApiKeyQuery(provider: ApiKeyProvider) {
  return useQuery({
    queryKey: API_KEY_QUERY_KEY(provider),
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) return false;
      const response = await window.api.settings.getApiKey({ provider });
      return unwrap<{ configured: boolean }>(response).configured;
    },
    // API Key 不应自动 refetch（变更频率低，且每次查询都需访问 keychain）
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * 设置 API Key mutation hook
 *
 * 调用 settings:setApiKey IPC，主进程加密后存储到 keychain。
 * 成功后自动失效对应 provider 的查询缓存，触发 UI 刷新。
 *
 * @returns TanStack Mutation 结果
 *
 * @example
 * ```tsx
 * const { mutate: setApiKey, isPending } = useSetApiKey();
 * const onSave = (provider, apiKey) => {
 *   setApiKey({ provider, apiKey }, {
 *     onSuccess: () => toast.success('API Key 已保存'),
 *   });
 * };
 * ```
 */
export function useSetApiKey() {
  // 本地化文案
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { provider: ApiKeyProvider; apiKey: string }) => {
      const response = await window.api.settings.setApiKey(params);
      return unwrap<{ ok: boolean }>(response);
    },
    onSuccess: (_data, variables) => {
      // 失效对应 provider 的查询缓存 + 共享 models 清单缓存：
      // 保存 Key 后 composer 模型选择器必须立即出现该提供商的模型
      //（此前仅失效 key 状态查询——聊天区选择器一直停留在「未配置模型」）
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY(variables.provider) });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('common.apiKeySaveFailed', { message }));
    },
  });
}

/**
 * 删除 API Key mutation hook
 *
 * 调用 settings:deleteApiKey IPC，主进程从 keychain 删除。
 * 成功后自动失效对应 provider 的查询缓存，触发 UI 刷新。
 *
 * @returns TanStack Mutation 结果
 */
export function useDeleteApiKey() {
  // 本地化文案
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (provider: ApiKeyProvider) => {
      const response = await window.api.settings.deleteApiKey({ provider });
      return unwrap<{ ok: boolean }>(response);
    },
    onSuccess: (_data, provider) => {
      // 删除 Key 同样失效 models 清单：该提供商模型应从选择器消失
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY(provider) });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('common.apiKeyDeleteFailed', { message }));
    },
  });
}
