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
import { type InfiniteData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
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

/** 单回合消息分组（页载荷按回合分组，turnId 是去重与游标推进的身份键） */
export interface TurnMessageGroup {
  readonly turnId: string;
  readonly messages: readonly ChatMessage[];
}

/**
 * 页游标：'latest' = 最近一页（窗口动态跟随回合列表末端，保证重进会话时
 * 最新回合总在缓存）；turnId = 锚定回合（窗口 [idx-10, idx)，**不含锚点**——
 * 下一页衔接到上一页左端）。
 *
 * 为什么用回合身份而非「已加载数量」（2026-09-25 审查修复）：数量游标的窗口
 * 按最新 turns.length 计算，回合列表增长（新回合结束触发 invalidate）后窗口
 * 相对已缓存页平移，fetchNextPage 会与旧页大幅重叠；身份游标的窗口只依赖
 * 锚点回合的索引（回合列表 append-only，索引稳定），且 React Query refetch
 * 会以 getNextPageParam 逐页递推（下一页锚点 = 当前页首回合）——布局在任何
 * 时刻都无缝衔接，无重叠无缺口。
 */
export type TurnPageParam = 'latest' | string;

/**
 * 单页回合消息原始拉取（hook 与路由 loader 共用）
 *
 * @param turns 回合列表（seq 升序）
 * @param param 页游标（见 TurnPageParam 注释）
 */
export async function fetchTurnMessagesPage(
  turns: readonly TurnSummary[],
  param: TurnPageParam,
): Promise<TurnMessagesPage> {
  let end: number;
  if (param === 'latest') {
    end = turns.length;
  } else {
    const anchor = turns.findIndex((t) => t.turnId === param);
    // 锚点回合不存在（回合不删除，防御）：空页让翻页判尽终止
    if (anchor === -1) {
      return { turnCount: 0, turns: [] };
    }
    end = anchor;
  }
  const start = Math.max(0, end - TURNS_PER_PAGE);
  const pageTurns = turns.slice(start, end);
  if (pageTurns.length === 0) {
    return { turnCount: 0, turns: [] };
  }
  const groups = await Promise.all(
    pageTurns.map(async (turn) => {
      const response = await window.api.session.getTurnMessages({ turnId: turn.turnId });
      return { turnId: turn.turnId, messages: unwrap(response).messages };
    }),
  );
  return { turnCount: groups.length, turns: groups };
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

/** 单页消息载荷（turns 按回合 seq 升序分组） */
export interface TurnMessagesPage {
  /** 本页回合数（含 0 消息的空回合也计数） */
  readonly turnCount: number;
  /** 本页回合分组（seq 升序；每回合含其全部消息） */
  readonly turns: readonly TurnMessageGroup[];
}

/**
 * 回合消息分页共通选项（useTurnMessagesInfinite / useTurnPagesInfinite 同 key 同
 * queryFn——同一缓存条目恒同形状；select 由两观察者各自应用，互不影响）
 *
 * 游标语义见 TurnPageParam 注释。getNextPageParam 返回本页最早回合的 turnId，
 * queryFn 据此取该回合**之前**的 TURNS_PER_PAGE 个回合——翻页与 refetch 都
 * 通过「下一页锚点 = 当前页首回合」递推，布局恒无缝。
 */
function turnPagesQueryOptions(id: string, turns: readonly TurnSummary[] | undefined) {
  return {
    queryKey: SESSION_TURN_PAGES_QUERY_KEY(id),
    enabled: turns !== undefined,
    initialPageParam: 'latest' as TurnPageParam,
    queryFn: async ({ pageParam }: { pageParam: TurnPageParam }): Promise<TurnMessagesPage> => {
      if (turns === undefined) {
        throw new Error('turns not loaded');
      }
      return fetchTurnMessagesPage(turns, pageParam);
    },
    // 本页最早回合已是全局最早 → 无更早页；否则以其 turnId 作下一页锚点
    getNextPageParam: (lastPage: TurnMessagesPage): TurnPageParam | undefined => {
      if (turns === undefined) return undefined;
      const first = lastPage.turns[0];
      if (first === undefined) return undefined;
      const oldest = turns[0];
      if (oldest !== undefined && first.turnId === oldest.turnId) return undefined;
      return first.turnId;
    },
    // 不启用 maxPages（2026-09-27 读 @tanstack/query-core@5.102.8 实证）：maxPages
    // 在每次追加页时生效，fetchNextPage（forward）走 addToEnd，超限 slice(1) 丢弃
    // pages[0]/pageParams[0]（infiniteQueryBehavior.js:36-40 + utils.js:151-154）；
    // 普通 refetch 又从 oldPageParams[0] 起逐页重放（infiniteQueryBehavior.js:52-58），
    // 被裁页不会自愈。本查询单向向上翻页，pages[0] 是最近一页消息（initialPageParam
    // 'latest'），flattenTurnPages 平铺全部 pages 渲染——被裁端正是聊天区最新可见
    // 消息。启用前提：接 fetchPreviousPage（backward 改裁尾端）或反转页序让最新页
    // 落在尾端，使被裁端不再是可见数据。
  };
}

/**
 * useTurnMessagesInfinite 的 select：InfiniteData → 时间正序消息数组
 *
 * select 收到的是 InfiniteData 对象而非 pages 数组，须经本包装拆 .pages 再走
 * flattenTurnPages（单一口径不变）；模块级函数保证 select 身份稳定，可复用
 * 观察者缓存的上次 select 结果（queryObserver 对同 data + 同 select 跳过重算）。
 */
function selectFlatTurnMessages(
  data: InfiniteData<TurnMessagesPage, TurnPageParam>,
): readonly ChatMessage[] {
  return flattenTurnPages(data.pages);
}

/**
 * 回合消息分页 hook（useInfiniteQuery，页序：pages[0] = 最近一页，越后越早）
 *
 * data 经 select selectFlatTurnMessages（→ flattenTurnPages）平铺为**时间正序
 * 消息数组**（去重单一口径），只消费消息序列的调用方（ChatPage initialMessages）
 * 无需再各自平铺；翻页 / 失效 / hasNextPage 语义不变。需要回合分组形状
 * （turnId 身份）的调用方用 {@link useTurnPagesInfinite}——平铺 ChatMessage
 * （AI SDK ModelMessage）不带 turnId，表达不了回合身份。
 *
 * @param id 会话 id
 * @param turns 回合列表（来自 useSessionTurns；undefined 时查询禁用）
 */
export function useTurnMessagesInfinite(id: string, turns: readonly TurnSummary[] | undefined) {
  return useInfiniteQuery({
    ...turnPagesQueryOptions(id, turns),
    select: selectFlatTurnMessages,
  });
}

/**
 * 回合消息分页原始形状观察者（useTurnMessagesInfinite 的同 key 非 select 镜像）
 *
 * data 为 InfiniteData<TurnMessagesPage>（pages[0] = 最近一页，越后越早）。存在
 * 原因：chat.tsx 的 shownTurnIdsRef 注册与 loadEarlier 去重按回合身份（turnId）
 * 过滤，而 ChatMessage 不携带 turnId——这两个消费点必须读原始分页形状。同 key
 * 同 queryFn（turnPagesQueryOptions 共用），与平铺观察者共享缓存 / 失效 / fetchNextPage。
 *
 * @param id 会话 id
 * @param turns 回合列表（来自 useSessionTurns；undefined 时查询禁用）
 */
export function useTurnPagesInfinite(id: string, turns: readonly TurnSummary[] | undefined) {
  return useInfiniteQuery(turnPagesQueryOptions(id, turns));
}

/**
 * 已加载消息按时间正序平铺（页序反转：最早页在前，回合内 seq 升序保持）
 *
 * 身份游标递推下相邻页理论无缝，但「翻页飞行中回合列表失效重取」的交错窗口
 * 可能产生页间重叠——按回合身份去重（保序首现）防御缓存瞬时混合布局。
 *
 * 现为 {@link useTurnMessagesInfinite} 的 select（单一口径，select 身份为模块级
 * 函数、可复用观察者缓存的上次 select 结果）；需要回合身份的消费方读
 * {@link useTurnPagesInfinite} 的原始分页形状。
 */
export function flattenTurnPages(
  pages: readonly TurnMessagesPage[] | undefined,
): readonly ChatMessage[] {
  if (pages === undefined) return [];
  const seen = new Set<string>();
  const groups: TurnMessageGroup[] = [];
  for (const page of [...pages].reverse()) {
    for (const group of page.turns) {
      if (seen.has(group.turnId)) continue;
      seen.add(group.turnId);
      groups.push(group);
    }
  }
  return groups.flatMap((group) => group.messages);
}
