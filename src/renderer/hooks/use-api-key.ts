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

import type { ApiKeyProvider } from '@novel-writer/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * Query key 工厂（按 provider 分桶）
 *
 * ['api-key', provider] 唯一标识单个 provider 的 API Key 查询缓存。
 */
export const API_KEY_QUERY_KEY = (provider: ApiKeyProvider) => ['api-key', provider] as const;

/**
 * 解包 IpcResponse：从 discriminated union 中提取 data 或抛错
 *
 * TanStack Query 期望 queryFn 抛错（自动进入 error 状态），
 * 因此 'error' 分支需要 throw，'data' 分支返回 data。
 */
function unwrap<T>(response: {
  readonly data?: T;
  readonly error?: { readonly code: string; readonly message: string };
}): T {
  if ('error' in response && response.error !== undefined) {
    throw new Error(`[${response.error.code}] ${response.error.message}`);
  }
  if ('data' in response && response.data !== undefined) {
    return response.data;
  }
  throw new Error('Unexpected response: missing data and error');
}

/**
 * API Key 查询 hook
 *
 * 调用 settings:getApiKey IPC 获取指定 provider 的 API Key 明文。
 * 主进程从 keychain 读取并解密后返回，未设置时返回 null。
 *
 * @param provider API 提供商标识（如 'deepseek'）
 * @returns TanStack Query 结果（data 为 string | null）
 *
 * @example
 * ```tsx
 * const { data: apiKey, isLoading } = useApiKey('deepseek');
 * if (isLoading) return <Loading />;
 * return apiKey ? <Badge>已配置</Badge> : <Button>设置 API Key</Button>;
 * ```
 */
export function useApiKeyQuery(provider: ApiKeyProvider) {
  return useQuery({
    queryKey: API_KEY_QUERY_KEY(provider),
    queryFn: async () => {
      if (typeof window === 'undefined' || window.api === undefined) return null;
      const response = await window.api.settings.getApiKey({ provider });
      return unwrap<{ apiKey: string | null }>(response).apiKey;
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { provider: ApiKeyProvider; apiKey: string }) => {
      const response = await window.api.settings.setApiKey(params);
      return unwrap<{ ok: boolean }>(response);
    },
    onSuccess: (_data, variables) => {
      // 失效对应 provider 的查询缓存，触发重新拉取
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY(variables.provider) });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`API Key 保存失败：${message}`);
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
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (provider: ApiKeyProvider) => {
      const response = await window.api.settings.deleteApiKey({ provider });
      return unwrap<{ ok: boolean }>(response);
    },
    onSuccess: (_data, provider) => {
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY(provider) });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(`API Key 删除失败：${message}`);
    },
  });
}
