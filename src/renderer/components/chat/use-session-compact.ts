// src/renderer/components/chat/use-session-compact.ts
// 会话上下文压缩 mutation（自 ChatPanel 提取的 L3 层 hook）
// ──────────────────────────────────────────────
// /compact 斜杠命令与自动压缩（use-auto-compact）共用：
// 主进程按模型窗口预算裁剪（compressByTokenBudget）后整体落库，
// 渲染层同步替换本地消息态（AI SDK v7 setMessages）。
// P2 修复：走 useMutation 并失效会话详情缓存——直连 IPC 不失效，
// staleTime 内重进会话会以压缩前旧消息重新初始化 useChat（压缩看似白做）。
// ──────────────────────────────────────────────

import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { toast } from 'sonner';

import { SESSION_DETAIL_QUERY_KEY } from '@/hooks/use-sessions';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrap, unwrapErrorMessage } from '@/lib/ipc';

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
  const { getErrorMessage } = useErrorMessage();

  const compactMutation = useMutation({
    mutationFn: async () => {
      // chatId 为必填 string（ChatPanelProps），无需空值守卫（此前 === undefined 分支
      // 恒 false，属类型收紧后的历史残留）
      return unwrap(await window.api.session.compact({ sessionId: chatId }));
    },
    onSuccess: (data) => {
      // data.messages 已是 ChatMessage[]（session:compact 契约），无需断言
      setMessages(toInitialMessages(data.messages));
      void queryClient.invalidateQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(chatId) });
      if (data.reclaimedTokens > 0) {
        toast.success(t('chat.compactDone', { tokens: data.reclaimedTokens }));
      } else {
        toast.info(t('chat.compactNothing'));
      }
    },
    // 统一走 unwrapErrorMessage（错误码 → i18n 单一真源）
    // 2026-09-06 审计修复：此前直接弹 error.message，[CODE] 前缀不会被本地化
    onError: (error: Error): void => {
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    },
  });

  return { compact: () => compactMutation.mutate() };
}
