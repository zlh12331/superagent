// src/renderer/hooks/use-api-key.ts
// API Key 管理 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 settings:setApiKey IPC（配置入口在 model-config-dialog）
// - 主进程通过 safeStorage 加密存储（Windows DPAPI / macOS Keychain / Linux libsecret）
// - 成功后自动失效共享缓存（模型选择器立即刷新）
//
// 设计依据（项目规范）：
// - "Server state from IPC `invoke` (request-response) must use TanStack Query
//    for caching, invalidation, and race condition handling"
// - API Key 在主进程 keychain 加密存储，渲染层只读写明文
//
// 历史：useApiKeyQuery / useDeleteApiKey 无生产消费方，已于 2026-08-27 审计后移除。
// ──────────────────────────────────────────────────────────────

import type { ApiKeyProvider } from '@code-agent/shared/renderer';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';
import { MODELS_QUERY_KEY } from './use-models';

/**
 * Query key 工厂（按 provider 分桶）
 *
 * ['api-key', provider] 唯一标识单个 provider 的 API Key 查询缓存；
 * set 成功后用于定向失效。
 */
export const API_KEY_QUERY_KEY = (provider: ApiKeyProvider) => ['api-key', provider] as const;

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
