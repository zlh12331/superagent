// src/renderer/components/chat/use-vim-mode.ts
// vim 编辑模式状态 hook（自 ChatInput 拆出：状态 + 键盘处理 + 光标）
// ──────────────────────────────────────────────
// 把 vim 模式的状态机从 ChatInput 抽出，让输入组件更精简。
// 返回 processKey：处理一次按键，返回 true 表示已被 vim 消费（需 preventDefault）。
// ──────────────────────────────────────────────

import { useCallback, useState } from 'react';

import { INITIAL_VIM_STATE, type VimState, vimHandleKey } from '@/lib/vim-mode';

/** vim hook 依赖（从 ChatInput 注入，避免 hook 耦合 store/组件） */
export interface UseVimModeDeps {
  /** 设置输入值（edit 分支回写） */
  readonly setValue: (next: string) => void;
}

/** vim hook 返回值 */
export interface UseVimModeResult {
  /** 当前 vim 状态（组件渲染需要） */
  readonly vimState: VimState;
  /** 待应用的光标位置（effect 负责 setSelectionRange） */
  readonly pendingCursor: number | null;
  /** 消费一次键盘事件；返回 true = vim 已处理（调用方需 preventDefault/stopPropagation） */
  readonly processKey: (
    event: { key: string; selectionStart: number | null },
    buffer: string,
  ) => boolean;
  /** 清空待应用光标（effect 用完后调用） */
  readonly clearPendingCursor: () => void;
}

/** 初始 vim 状态（供引用） */
export const VIM_INITIAL_STATE = INITIAL_VIM_STATE;

/**
 * vim 编辑模式状态 hook
 *
 * 封装 vimState / pendingCursor 状态机与键盘处理。组件仅需注入 value/setValue。
 */
export function useVimMode({ setValue }: UseVimModeDeps): UseVimModeResult {
  const [vimState, setVimState] = useState<VimState>(INITIAL_VIM_STATE);
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);

  const processKey = useCallback(
    (event: { key: string; selectionStart: number | null }, buffer: string): boolean => {
      const result = vimHandleKey(
        vimState,
        event.key,
        buffer,
        event.selectionStart ?? buffer.length,
      );
      if (result.type !== 'noop' || vimState.mode === 'normal') {
        if (result.type === 'edit' && result.value !== undefined) {
          setValue(result.value);
          setPendingCursor(result.cursor ?? 0);
        } else if (result.type === 'move' && result.cursor !== undefined) {
          setPendingCursor(result.cursor);
        }
        setVimState(result.state);
        return true;
      }
      return false;
    },
    [vimState, setValue],
  );

  const clearPendingCursor = useCallback((): void => {
    setPendingCursor(null);
  }, []);

  return { vimState, pendingCursor, processKey, clearPendingCursor };
}
