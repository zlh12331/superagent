import { useEffect, useRef, useState } from 'react';

import { useDraftStore } from '@/stores/persistent/draft-store';
import type { ChatAttachment } from './attachments';
import { attachmentName } from './attachments';

/** useComposerInput 依赖 */
export interface UseComposerInputDeps {
  /** 会话 id（草稿 key；undefined = 无草稿语义） */
  readonly chatId: string | undefined;
  /** 受控值（存在即受控模式） */
  readonly controlledValue: string | undefined;
  /** 受控值变更回调 */
  readonly onValueChange: ((value: string) => void) | undefined;
  /** 外部注入值（非受控模式同步用） */
  readonly injectedValue: string | undefined;
  /** 输入/注入后回调（autoResize 等；调用方需传 stable 引用） */
  readonly onAfterChange?: () => void;
}

/** useComposerInput 返回值 */
export interface UseComposerInputResult {
  /** 当前值（受控读 controlledValue，非受控读内部） */
  readonly value: string;
  /** 设置值（受控回调 / 非受控内部） */
  readonly setValue: (next: string) => void;
  /** 附件列表 */
  readonly attachments: readonly ChatAttachment[];
  /** 选择附件（去重添加） */
  readonly pickAttachments: (paths: readonly string[]) => void;
  /** 移除附件 */
  readonly removeAttachment: (path: string) => void;
  /** 清空输入与附件（发送成功后） */
  readonly clear: () => void;
  /** 是否受控模式 */
  readonly isControlled: boolean;
}

function restoreDraftAttachments(chatId: string | undefined): ChatAttachment[] {
  if (chatId === undefined) {
    return [];
  }
  return useDraftStore
    .getState()
    .getDraft(chatId)
    .attachments.map((p) => ({ path: p, name: attachmentName(p) }));
}

/**
 * composer 输入状态 hook（输入值 + 附件 + 草稿）
 *
 * @example
 * const { value, setValue, attachments, clear } = useComposerInput({ chatId, controlledValue, ... });
 */
export function useComposerInput({
  chatId,
  controlledValue,
  onValueChange,
  injectedValue,
  onAfterChange,
}: UseComposerInputDeps): UseComposerInputResult {
  const isControlled = controlledValue !== undefined;
  const [internalValue, setInternalValue] = useState(() => {
    return (
      controlledValue ??
      (chatId !== undefined ? useDraftStore.getState().getDraft(chatId).text : '')
    );
  });
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() =>
    restoreDraftAttachments(chatId),
  );
  const value = isControlled ? controlledValue : internalValue;

  const setValue = (next: string): void => {
    if (!isControlled) {
      setInternalValue(next);
    }
    onValueChange?.(next);
    onAfterChange?.();
  };

  const pickAttachments = (paths: readonly string[]): void => {
    setAttachments((prev) => {
      const seen = new Set(prev.map((a) => a.path));
      const next = [...prev];
      for (const p of paths) {
        if (seen.has(p)) continue;
        seen.add(p);
        next.push({ path: p, name: p.split(/[\\/]/).pop() ?? p });
      }
      return next;
    });
  };

  const removeAttachment = (path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const clear = (): void => {
    if (!isControlled) {
      setInternalValue('');
    }
    onValueChange?.('');
    setAttachments([]);
    onAfterChange?.();
  };

  useEffect(() => {
    if (injectedValue === undefined || isControlled) {
      return;
    }
    setInternalValue(injectedValue);
    onAfterChange?.();
  }, [injectedValue, isControlled, onAfterChange]);

  const draftSyncedChatIdRef = useRef(chatId);
  useEffect(() => {
    if (isControlled || chatId === undefined) {
      return;
    }
    if (chatId !== draftSyncedChatIdRef.current) {
      draftSyncedChatIdRef.current = chatId;
      return;
    }
    useDraftStore.getState().setDraft(chatId, {
      text: internalValue,
      attachments: attachments.map((a) => a.path),
    });
  }, [internalValue, attachments, chatId, isControlled]);

  const prevChatIdRef = useRef(chatId);
  useEffect(() => {
    if (chatId === prevChatIdRef.current || chatId === undefined || isControlled) {
      prevChatIdRef.current = chatId;
      return;
    }
    prevChatIdRef.current = chatId;
    const draft = useDraftStore.getState().getDraft(chatId);
    setInternalValue(draft.text);
    setAttachments(draft.attachments.map((p) => ({ path: p, name: attachmentName(p) })));
    onAfterChange?.();
  }, [chatId, isControlled, onAfterChange]);

  return { value, setValue, attachments, pickAttachments, removeAttachment, clear, isControlled };
}
