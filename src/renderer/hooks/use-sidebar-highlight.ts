import { useEffect, useRef, useState } from 'react';

import {
  SEARCH_HIGHLIGHT_DEBOUNCE_MS,
  SEARCH_HIGHLIGHT_EXPIRE_MS,
  SEARCH_HIGHLIGHT_MIN_CHARS,
} from '@/lib/constants';

/** 参与高亮匹配的最小字段集（结构化兼容 SidebarSession / SessionMeta） */
export interface HighlightTarget {
  readonly id: string;
  readonly title: string;
  readonly workingDir: string;
}

/**
 * 计算搜索匹配的会话 id 集合
 *
 * 纯函数（导出供单测）：标题或工作目录命中即算匹配，大小写不敏感。
 *
 * 返回值三态（调用方必须区分后两者，否则会丢掉「清除高亮」语义）：
 * - `null`：关键词过短（< SEARCH_HIGHLIGHT_MIN_CHARS）→ 调用方不动作，
 *   让既有高亮自然过期（对齐原型「输入太短不打断当前高亮」的行为）
 * - 非空 Set：命中项 → 高亮
 * - 空 Set：关键词够长但无命中 → **清除**既有高亮
 *
 * @param sessions 候选会话
 * @param keyword 用户输入（函数内部 trim + 小写化）
 * @returns 匹配 id 集合；关键词过短时为 null
 */
export function computeHighlightedIds(
  sessions: readonly HighlightTarget[],
  keyword: string,
): Set<string> | null {
  const q = keyword.trim().toLowerCase();
  if (q.length < SEARCH_HIGHLIGHT_MIN_CHARS) return null;
  const matched = new Set<string>();
  for (const session of sessions) {
    if (session.title.toLowerCase().includes(q) || session.workingDir.toLowerCase().includes(q)) {
      matched.add(session.id);
    }
  }
  return matched;
}

/**
 * 侧边栏搜索高亮
 *
 * @param keyword 搜索关键词（防抖输入）
 * @param sessions 会话列表（经 ref 读取最新值，不进防抖依赖）
 * @returns 当前应高亮的会话 id 集合
 *
 * @example
 * ```tsx
 * const { highlightedIds } = useSidebarHighlight(searchKeyword, sessions);
 * // <SortableThreadItem highlighted={highlightedIds.has(session.id)} />
 * ```
 */
export function useSidebarHighlight(
  keyword: string,
  sessions: readonly HighlightTarget[],
): { highlightedIds: ReadonlySet<string> } {
  const [highlightedIds, setHighlightedIds] = useState<Set<string>>(() => new Set());
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const matched = computeHighlightedIds(sessionsRef.current, keyword);
      if (matched === null) return;
      setHighlightedIds(matched);

      if (expireTimerRef.current !== null) {
        clearTimeout(expireTimerRef.current);
      }
      expireTimerRef.current = setTimeout(() => {
        setHighlightedIds(new Set());
        expireTimerRef.current = null;
      }, SEARCH_HIGHLIGHT_EXPIRE_MS);
    }, SEARCH_HIGHLIGHT_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [keyword]);

  useEffect(() => {
    return () => {
      if (expireTimerRef.current !== null) {
        clearTimeout(expireTimerRef.current);
        expireTimerRef.current = null;
      }
    };
  }, []);

  return { highlightedIds };
}
