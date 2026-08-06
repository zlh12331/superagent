// src/renderer/components/chat/conversation-search-bar.tsx
// 会话内搜索栏（对齐参考项目 superagent ConversationSearchBar + 原型 .conv-search-bar）
// ──────────────────────────────────────────────────────────────
// 受控组件：query / 匹配计数 / 导航由父组件（ChatPanel）持有状态，
// 本组件仅负责 UI 展示与事件转发。
// 键盘：Enter=下一个匹配 / Shift+Enter=上一个 / Esc=关闭
// ──────────────────────────────────────────────────────────────

import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { type KeyboardEvent, type ReactElement, useEffect, useRef } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 搜索栏 props（受控） */
export interface ConversationSearchBarProps {
  /** 是否可见（false 时不渲染） */
  readonly visible: boolean;
  /** 查询文本（受控） */
  readonly query: string;
  /** 匹配总数 */
  readonly totalMatches: number;
  /** 当前匹配序号（1-based；无匹配为 0） */
  readonly currentMatch: number;
  /** 查询变化回调 */
  readonly onSearch: (query: string) => void;
  /** 导航回调：1=下一个，-1=上一个 */
  readonly onNavigate: (dir: 1 | -1) => void;
  /** 关闭回调 */
  readonly onClose: () => void;
}

/**
 * 会话内搜索栏
 */
export function ConversationSearchBar({
  visible,
  query,
  totalMatches,
  currentMatch,
  onSearch,
  onNavigate,
  onClose,
}: ConversationSearchBarProps): ReactElement | null {
  const { t } = useTranslation();
  // 挂载时聚焦输入框（autoFocus 属性被 biome noAutofocus 禁用，改用 ref）
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (visible) {
      inputRef.current?.focus();
    }
  }, [visible]);

  if (!visible) return null;

  const hasQuery = query.trim() !== '';
  const hasMatches = totalMatches > 0;

  /** 键盘导航：Enter=下一个 / Shift+Enter=上一个 / Esc=关闭 */
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onNavigate(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <search
      className="bg-card flex items-center gap-1.5 border-b px-3 py-1.5"
      aria-label={t('chat.searchAriaLabel')}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onSearch(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={t('chat.searchPlaceholder')}
        autoComplete="off"
        spellCheck={false}
        aria-label={t('chat.searchInputAriaLabel')}
        className="border-border bg-background focus:border-primary min-w-0 flex-1 rounded-[4px] border px-2 py-1 text-xs transition-colors focus:outline-none"
      />
      {/* 匹配计数（有查询时显示） */}
      {hasQuery && (
        <span
          className="text-muted-foreground shrink-0 font-mono text-[11px] tabular-nums"
          aria-live="polite"
        >
          {hasMatches ? `${currentMatch}/${totalMatches}` : '0/0'}
        </span>
      )}
      {/* 上一个匹配（↑） */}
      <button
        type="button"
        onClick={() => onNavigate(-1)}
        disabled={!hasMatches}
        aria-label={t('chat.searchPrev')}
        title={t('chat.searchPrev')}
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] px-1.5 py-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronUp className="size-3" />
      </button>
      {/* 下一个匹配（↓） */}
      <button
        type="button"
        onClick={() => onNavigate(1)}
        disabled={!hasMatches}
        aria-label={t('chat.searchNext')}
        title={t('chat.searchNext')}
        className="text-muted-foreground hover:bg-muted hover:text-foreground flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] px-1.5 py-[3px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
      >
        <ChevronDown className="size-3" />
      </button>
      {/* 关闭（X） */}
      <button
        type="button"
        onClick={onClose}
        aria-label={t('common.close')}
        title={t('common.close')}
        className={cn(
          'text-muted-foreground hover:bg-muted hover:text-foreground flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] px-1.5 py-[3px] transition-colors',
        )}
      >
        <X className="size-3.5" />
      </button>
    </search>
  );
}
