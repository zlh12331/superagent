// src/renderer/hooks/use-session-turns.ts
// 会话历史按回合增量加载（L3 服务端请求状态层；debt.md#d2/#d4 根治）
// ──────────────────────────────────────────────────────────────
// 背景：此前 ChatPage 经 session:get 全量拉取消息历史，长会话下 IPC 负载
// 与内存随消息数线性增长。改造后：
// - 元数据走 session:get({ includeMessages: false })（见 use-sessions.ts）
// - 回合元数据走 session:getTurns（摘要体量小，一次全量）
// - 消息体走 session:getTurnMessages 按回合分页增量拉取
//   （useInfiniteQuery：首页 = 最近 TURNS_PER_PAGE 个回合，向上翻页加载更早）
//
// 数据不变量（依赖主进程保证）：所有持久化消息均带 turnId（agent-service 回合
// 开始统一落用户消息 + persistTurn 落助手消息；cron 预落库重复行已移除）。
// 已知边界（如实登记）：/compact 后的压缩上下文消息无 turnId（「旧上下文不可
// 回放」的既有语义），按回合重建不含它们——见 docs/design/debt.md#d2。
// ──────────────────────────────────────────────────────────────

import type { ChatMessage, TurnSummary } from '@code-agent/shared/renderer';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { unwrap } from '@/lib/ipc';

/**
 * Query key 常量（挂在 ['session', id] 前缀下：use-agent-bridge 回合结束
 * invalidate SESSION_DETAIL_QUERY_KEY(id) 时前缀匹配自动覆盖本域，无需另加失效点）
 */

/** 会话回合列表（回合元数据） */
export const SESSION_TURNS_QUERY_KEY = (id: string) => ['session', id, 'turns'] as const;
/** 回合消息分页（增量消息体） */
export const SESSION_TURN_PAGES_QUERY_KEY = (id: string) => ['session', id, 'turn-pages'] as const;

/** 每页回合数（首屏消息量 ≈ TURNS_PER_PAGE × 每回合 2 条，滚动到顶加载更早页） */
export const TURNS_PER_PAGE = 10;

/** 回合列表原始拉取（hook 与路由 loader 共用，保证缓存形状一致） */
export async function fetchSessionTurns(id: string) {
  const response = await window.api.session.getTurns({ sessionId: id });
  return unwrap(response);
}

/**
 * 单页回合消息原始拉取：从「最近」取 [fromEnd, fromEnd + TURNS_PER_PAGE) 窗内
 * 回合，并发拉取消息明细后按回合顺序平铺（hook 与路由 loader 共用）
 */
export async function fetchTurnMessagesPage(
  turns: readonly TurnSummary[],
  fromEnd: number,
): Promise<TurnMessagesPage> {
  const end = Math.max(0, turns.length - fromEnd);
  const start = Math.max(0, end - TURNS_PER_PAGE);
  const pageTurns = turns.slice(start, end);
  if (pageTurns.length === 0) {
    return { turnCount: 0, messages: [] };
  }
  const batches = await Promise.all(
    pageTurns.map(async (turn) => {
      const response = await window.api.session.getTurnMessages({ turnId: turn.turnId });
      return unwrap(response).messages;
    }),
  );
  return { turnCount: pageTurns.length, messages: batches.flat() };
}

/**
 * 回合列表查询 hook（回合元数据，摘要体量小，一次全量）
 *
 * @param id 会话 id（null 时跳过查询）
 */
export function useSessionTurns(id: string | null) {
  return useQuery({
    queryKey: SESSION_TURNS_QUERY_KEY(id ?? 'unknown'),
    queryFn: async () => {
      if (id === null) {
        throw new Error('id is null');
      }
      return fetchSessionTurns(id);
    },
    enabled: id !== null,
  });
}

/** 单页消息载荷（messages 按回合 seq 升序平铺） */
export interface TurnMessagesPage {
  /** 本页回合数（翻页游标推进用；含 0 消息的空回合也计数） */
  readonly turnCount: number;
  /** 本页全部消息（回合内按 seq 升序；页与页之间新的在前） */
  readonly messages: readonly ChatMessage[];
}

/**
 * 回合消息分页 hook（useInfiniteQuery，页序：pages[0] = 最近一页，越后越早）
 *
 * pageParam 语义：已从「最近」加载的回合数（0 = 首页）。每页并发拉取该页
 * 全部回合的消息明细（本地 IPC，毫秒级），按回合顺序平铺。
 *
 * @param id 会话 id
 * @param turns 回合列表（来自 useSessionTurns；undefined 时查询禁用）
 */
export function useTurnMessagesInfinite(id: string, turns: readonly TurnSummary[] | undefined) {
  return useInfiniteQuery({
    queryKey: SESSION_TURN_PAGES_QUERY_KEY(id),
    enabled: turns !== undefined,
    initialPageParam: 0,
    queryFn: async ({ pageParam }): Promise<TurnMessagesPage> => {
      if (turns === undefined) {
        throw new Error('turns not loaded');
      }
      return fetchTurnMessagesPage(turns, pageParam);
    },
    // 已加载回合数未达总回合数时继续翻页
    getNextPageParam: (_lastPage, allPages) => {
      if (turns === undefined) return undefined;
      const loaded = allPages.reduce((sum, page) => sum + page.turnCount, 0);
      return loaded < turns.length ? loaded : undefined;
    },
  });
}

/**
 * 已加载消息按时间正序平铺（页序反转：最早页在前，回合内 seq 升序保持）
 *
 * ChatPanel 的 initialMessages / 向上补页 prepend 均以此为单一口径。
 */
export function flattenTurnPages(
  pages: readonly TurnMessagesPage[] | undefined,
): readonly ChatMessage[] {
  if (pages === undefined) return [];
  return [...pages].reverse().flatMap((page) => page.messages);
}
