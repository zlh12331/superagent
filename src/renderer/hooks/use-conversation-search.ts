// src/renderer/hooks/use-conversation-search.ts
// 会话内搜索状态（对齐参考项目 superagent ConversationSearchBar + useConversationSearch）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 管理搜索状态（visible / query / currentMatch / totalMatches）
// - findMessageMatches：消息级匹配纯函数（可单测）
// - 导航循环：↑↓ / Enter / Shift+Enter 在匹配项间循环
// ──────────────────────────────────────────────────────────────

import type { UIMessage } from 'ai';
import { useCallback, useMemo, useState } from 'react';
import { extractText } from '@/components/chat/message-utils';

/** 搜索状态 */
export interface ConversationSearchState {
  /** 搜索栏是否可见 */
  readonly visible: boolean;
  /** 当前查询文本 */
  readonly query: string;
  /** 匹配消息索引列表（在 messages 数组中的下标） */
  readonly matchIndexes: readonly number[];
  /** 当前匹配项在 matchIndexes 中的位置（0-based；无匹配为 -1） */
  readonly currentMatch: number;
}

/** 搜索操作 */
export interface ConversationSearchActions {
  /** 打开搜索栏 */
  readonly open: () => void;
  /** 关闭搜索栏并清除状态 */
  readonly close: () => void;
  /** 更新查询（重新计算匹配） */
  readonly search: (query: string) => void;
  /** 导航：1=下一个，-1=上一个（循环） */
  readonly navigate: (dir: 1 | -1) => void;
}

/**
 * 消息级匹配（大小写不敏感；匹配消息的文本内容）
 *
 * @param messages 消息列表
 * @param query 查询文本（空串返回空）
 * @returns 匹配消息在 messages 中的下标列表
 */
export function findMessageMatches(
  messages: readonly UIMessage[],
  query: string,
): readonly number[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [];
  const indexes: number[] = [];
  for (const [i, message] of messages.entries()) {
    const text = extractText(message.parts).toLowerCase();
    if (text.includes(q)) {
      indexes.push(i);
    }
  }
  return indexes;
}

/**
 * 会话内搜索 hook
 *
 * @param messages 消息列表（匹配计算的输入）
 * @returns 搜索状态 + 操作
 */
export function useConversationSearch(messages: readonly UIMessage[]): ConversationSearchState & {
  readonly actions: ConversationSearchActions;
} {
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState('');
  const [currentMatch, setCurrentMatch] = useState(-1);

  // 匹配计算（query 变化时重算）
  const matchIndexes = useMemo(() => findMessageMatches(messages, query), [messages, query]);

  const open = useCallback(() => {
    setVisible(true);
    setQuery('');
    setCurrentMatch(-1);
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setQuery('');
    setCurrentMatch(-1);
  }, []);

  const search = useCallback((nextQuery: string) => {
    setQuery(nextQuery);
    // 重置到第一个匹配（查询变化时）
    setCurrentMatch(nextQuery.trim() === '' ? -1 : 0);
  }, []);

  const navigate = useCallback(
    (dir: 1 | -1) => {
      if (matchIndexes.length === 0) return;
      setCurrentMatch((prev) => {
        // 无当前匹配（-1）时：下一个=第一个，上一个=最后一个
        if (prev === -1) {
          return dir === 1 ? 0 : matchIndexes.length - 1;
        }
        return (prev + dir + matchIndexes.length) % matchIndexes.length;
      });
    },
    [matchIndexes],
  );

  return {
    visible,
    query,
    matchIndexes,
    currentMatch,
    actions: { open, close, search, navigate },
  };
}
