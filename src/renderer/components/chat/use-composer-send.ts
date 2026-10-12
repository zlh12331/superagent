import { MAX_MESSAGE_LENGTH_CHARS } from '@code-agent/shared/renderer';
import { useRef, useState } from 'react';
import { toast } from 'sonner';

import { useTranslation } from '@/i18n/use-translation';
import { useDraftStore } from '@/stores/persistent/draft-store';
import { buildTextWithAttachments, type ChatAttachment } from './attachments';

/** 消息最大长度（对齐 shared 单一真源 MAX_MESSAGE_LENGTH_CHARS=8000） */
const MAX_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH_CHARS;

/** useComposerSend 依赖 */
export interface UseComposerSendDeps {
  /** 当前输入文本（非空校验 + 发送内容基准） */
  readonly value: string;
  /** 附件列表（内容拼接输入） */
  readonly attachments: readonly ChatAttachment[];
  /** 会话 id（发送成功后清草稿；undefined = 无草稿语义） */
  readonly chatId: string | undefined;
  /** 清空输入与附件（useComposerInput.clear） */
  readonly clearInput: () => void;
  /** 发送回调（父组件注入 sendMessage） */
  readonly onSend: (text: string) => void;
  /** 是否流式中（发送禁用 + 显示停止按钮） */
  readonly isStreaming: boolean;
  /** 是否禁用（如未配置 API Key） */
  readonly disabled: boolean;
}

/** useComposerSend 返回值 */
export interface ComposerSend {
  /** 是否可发送（非空 + 非流式 + 未禁用 + 不在发送中） */
  readonly canSend: boolean;
  /** 发送当前文本：守卫 → 超长拦截 → 附件拼接 → 清草稿与输入 */
  readonly handleSend: () => Promise<void>;
}

/**
 * composer 发送管线 hook
 *
 * @example
 * ```tsx
 * const { canSend, handleSend } = useComposerSend({ value, attachments, chatId, ... });
 * ```
 */
export function useComposerSend({
  value,
  attachments,
  chatId,
  clearInput,
  onSend,
  isStreaming,
  disabled,
}: UseComposerSendDeps): ComposerSend {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  /** in-flight 发送守卫（ref 同步拦截同帧重复触发；state 驱动按钮禁用渲染） */
  const sendingRef = useRef(false);
  const canSend = value.trim().length > 0 && !isStreaming && !disabled && !sending;

  const handleSend = async (): Promise<void> => {
    if (!canSend || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      const base = value.trim();
      if (base.length > MAX_MESSAGE_LENGTH) {
        toast.error(t('chat.messageTooLong', { max: MAX_MESSAGE_LENGTH }));
      } else {
        const text = await buildTextWithAttachments(base, attachments, {
          attached: (name) => t('chat.attachmentLabel', { name }),
          readFailed: (name) => t('chat.attachmentReadFailed', { name }),
          truncated: (chars) => t('chat.attachmentTruncated', { chars }),
        });
        onSend(text);
        if (chatId !== undefined) {
          useDraftStore.getState().clearDraft(chatId);
        }
        clearInput();
      }
    } catch {
      toast.error(t('chat.sendFailed'));
    }
    sendingRef.current = false;
    setSending(false);
  };

  return { canSend, handleSend };
}
