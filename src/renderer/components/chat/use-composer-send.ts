// src/renderer/components/chat/use-composer-send.ts
// composer 发送管线（自 ChatInput 拆出）
// ──────────────────────────────────────────────
// 职责（单一内聚：一次发送的完整流程）：
// - in-flight 守卫（ref 同步拦截同帧重复触发；state 驱动按钮禁用渲染）
// - 超长拦截（对齐 shared 单一真源 MAX_MESSAGE_LENGTH_CHARS）
// - 附件内容拼接（attachments.ts 的 buildTextWithAttachments）
// - 发送成功清草稿与输入、失败 toast、守卫复位（三路径统一）
//
// 为什么抽出：① 守卫在 await 窗口期的复位曾出真实缺陷（回调抛错会让守卫卡死、
// 发送按钮本会话永久禁用），独立成 hook 后可脱离组件单测该路径；
// ② ChatInput 由此收敛为「编排 composer 各 hook + JSX」，与
// use-composer-input/drag/suggest/vim 形成对称结构。
// ──────────────────────────────────────────────

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
    // in-flight 守卫：附件拼接含真实 IPC 往返，await 窗口内 status 仍为
    // ready，二次 Enter/点击会重复发送；此处硬拦截（不依赖渲染期的 canSend）
    if (!canSend || sendingRef.current) {
      return;
    }
    sendingRef.current = true;
    setSending(true);
    try {
      // trim：对齐原型 send() 的 input.value.trim()（避免首尾空格进入消息）
      const base = value.trim();
      // 超长拦截（对齐 shared 单一真源 MAX_MESSAGE_LENGTH_CHARS）
      if (base.length > MAX_MESSAGE_LENGTH) {
        toast.error(t('chat.messageTooLong', { max: MAX_MESSAGE_LENGTH }));
      } else {
        const text = await buildTextWithAttachments(base, attachments, {
          attached: (name) => t('chat.attachmentLabel', { name }),
          readFailed: (name) => t('chat.attachmentReadFailed', { name }),
        });
        onSend(text);
        // 发送成功：清除本会话草稿（草稿只保留未发送内容）
        if (chatId !== undefined) {
          useDraftStore.getState().clearDraft(chatId);
        }
        // 清空输入与附件（in-flight 守卫已挡住 await 期间的重复发送）
        clearInput();
      }
    } catch {
      // 回调异常兜底（buildTextWithAttachments 内部已自行吞掉读取异常，失败仅追加标注）
      toast.error(t('chat.sendFailed'));
    }
    // finally 语义（React Compiler 不优化 try/finally）：超长拦截、正常发送、回调异常
    // 三条路径统一在此复位 in-flight 守卫——此前复位在 try 之外且无 catch，回调抛错
    // 会让守卫卡死、发送按钮在本会话内永久禁用
    sendingRef.current = false;
    setSending(false);
  };

  return { canSend, handleSend };
}
