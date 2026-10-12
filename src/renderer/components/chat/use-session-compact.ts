import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { toast } from 'sonner';

import { useMutationOnError } from '@/hooks/use-mutation-error';
import { SESSION_DETAIL_QUERY_KEY } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { unwrap } from '@/lib/ipc';

import { toInitialMessages } from './history-parts';

/** useSessionCompact 依赖 */
export interface UseSessionCompactDeps {
  /** 会话 id（session:compact 目标） */
  readonly chatId: string;
  /** 本地消息态替换（useAgentWithIpc 的 setMessages） */
  readonly setMessages: (messages: UIMessage[]) => void;
}

/**
 * 会话上下文压缩 hook（mutation + 缓存失效 + 本地消息态替换 + 结果反馈）
 *
 * @example
 * ```tsx
 * const { compact } = useSessionCompact({ chatId, setMessages });
 * ```
 */
export function useSessionCompact({ chatId, setMessages }: UseSessionCompactDeps): {
  compact: () => void;
} {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const onError = useMutationOnError();

  const compactMutation = useMutation({
    mutationFn: async () => {
      return unwrap(await window.api.session.compact({ sessionId: chatId }));
    },
    onSuccess: (data) => {
      setMessages(toInitialMessages(data.messages));
      void queryClient.invalidateQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(chatId) });
      if (data.reclaimedTokens > 0) {
        toast.success(t('chat.compactDone', { tokens: data.reclaimedTokens }));
      } else {
        toast.info(t('chat.compactNothing'));
      }
    },
    onError,
  });

  return { compact: () => compactMutation.mutate() };
}
