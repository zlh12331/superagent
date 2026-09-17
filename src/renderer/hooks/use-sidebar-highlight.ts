// src/renderer/hooks/use-sidebar-highlight.ts
// 侧边栏会话搜索高亮（防抖计算 + 定时过期）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 关键词变化 → 300ms 防抖后计算匹配的会话 id 集合
// - 高亮 2 秒后自动清除（对齐原型 I-S-001 的闪烁高亮效果）
// - 少于 SEARCH_HIGHLIGHT_MIN_CHARS 字符不计算（对齐原型 q.length < 2）
// - 卸载时清理在途定时器
//
// 提取动机（2026-09 layout 审计）：该副作用原内联在 Sidebar 组件内（约 45 行
// 含 3 个 effect/ref），使 Sidebar 成为认知复杂度 16、函数体 219 行的双基线条目。
// 高亮是「输入 → 延时视觉效果」的独立时间语义，与列表编排无关，提到 hook 后
// 组件只消费返回值，且该行为可脱离 Sidebar 单独测试。
//
// 与即时过滤的关系：**两者刻意分离**——列表过滤即时生效（保输入响应性），
// 高亮才防抖（对齐原型的 300ms 视觉节奏）。不要合并。
// ──────────────────────────────────────────────────────────────

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
  // 高亮过期定时器：新的防抖触发时清掉上一个，避免多次搜索叠加
  const expireTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 经 ref 读最新 sessions：若把它放进 effect 依赖，缓存刷新 / 乐观更新回写
  // 会重置防抖计时器，输入过程中的高亮计算被反复打断。
  // 在 effect 中同步（react-hooks/refs 禁止渲染阶段写 ref.current）。
  const sessionsRef = useRef(sessions);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    const timer = setTimeout(() => {
      const matched = computeHighlightedIds(sessionsRef.current, keyword);
      // 关键词过短（null）：不主动清除，让既有高亮自然过期（对齐原型行为）
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
    // 仅依赖 keyword；sessions 经 ref 读取（见上）
  }, [keyword]);

  // 卸载清理在途过期定时器（防内存泄漏）
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
