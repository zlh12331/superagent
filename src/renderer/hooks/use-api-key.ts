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
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: { provider: ApiKeyProvider; apiKey: string }) => {
      const response = await window.api.settings.setApiKey(params);
      return unwrap<{ ok: boolean }>(response);
    },
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: API_KEY_QUERY_KEY(variables.provider) });
      void queryClient.invalidateQueries({ queryKey: MODELS_QUERY_KEY });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('common.apiKeySaveFailed', { message }));
    },
  });
}
