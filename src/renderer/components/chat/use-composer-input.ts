// src/renderer/components/chat/use-composer-input.ts
// composer 输入状态 hook（自 ChatInput 拆出）
// ──────────────────────────────────────────────
// 职责（单一内聚：共同构成「会话草稿」的状态）：
// - 输入文本值（受控/非受控双模）
// - 附件列表（选择/移除）
// - 草稿持久化（恢复/保存/切换会话恢复）
// - 发送后清空（clear）
// 不含 autoResize/focus（渲染职责由调用方基于 value 触发）；不含发送逻辑。
// ──────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from 'react';

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
    // 草稿恢复：非受控 + 有 chatId 时从 draft-store 初始化
    return (
      controlledValue ??
      (chatId !== undefined ? useDraftStore.getState().getDraft(chatId).text : '')
    );
  });
  const [attachments, setAttachments] = useState<ChatAttachment[]>(() =>
    restoreDraftAttachments(chatId),
  );
  const value = isControlled ? controlledValue : internalValue;

  const setValue = useCallback(
    (next: string): void => {
      if (!isControlled) {
        setInternalValue(next);
      }
      onValueChange?.(next);
      onAfterChange?.();
    },
    [isControlled, onValueChange, onAfterChange],
  );

  const pickAttachments = useCallback((paths: readonly string[]): void => {
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
  }, []);

  const removeAttachment = useCallback((path: string): void => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const clear = useCallback((): void => {
    if (!isControlled) {
      setInternalValue('');
    }
    onValueChange?.('');
    setAttachments([]);
    onAfterChange?.();
  }, [isControlled, onValueChange, onAfterChange]);

  // 外部注入值（编辑重提 / 目标预填）：非受控模式同步，保持草稿语义
  // 受控模式跳过：value 由外部持有，setInternalValue 是无效写入（且会破坏受控语义）
  useEffect(() => {
    if (injectedValue === undefined || isControlled) {
      return;
    }
    setInternalValue(injectedValue);
    onAfterChange?.();
  }, [injectedValue, isControlled, onAfterChange]);

  // 草稿保存：非受控 + 有 chatId 时，文本/附件变化写入 draft-store
  // 切换帧守卫：chatId 变化的那次渲染 internalValue 仍是旧会话内容，跳过防交叉污染
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

  // 会话切换（chatId 变化）：恢复新会话草稿（prevThreadId 模式）
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
