// src/renderer/hooks/use-sessions.ts
// 会话数据查询 hook（L3 服务端请求状态层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 通过 TanStack Query 调用 session:list / get / delete / rename IPC
// - 自动处理缓存失效 + 竞态 + 重试（QueryClient 默认配置）
// - 提供乐观更新（delete / rename 时本地缓存先变，再等服务端确认）
//
// 设计依据（项目规范）：
// - "Server state from IPC `invoke` (request-response) must use TanStack Query
//    for caching, invalidation, and race condition handling"
// - sessions 列表为 IPC invoke（请求-响应），不应在 Zustand 中持久化
//   （SQLite 已是单一真源，localStorage 缓存会引入双份一致性问题）
//
// 缓存策略：
// - queryKey: ['sessions'] - 会话列表
// - queryKey: ['session', id] - 单个会话详情（含 messages）
// - staleTime: 30s（默认，避免组件 remount 重复请求）
// - delete / rename mutation 后 invalidate ['sessions']，触发列表刷新
// ──────────────────────────────────────────────────────────────

import type { SessionMeta } from '@code-agent/shared/renderer';
import {
  type InfiniteData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { toast } from 'sonner';
import { useErrorMessage } from '@/i18n/use-translation';
import { hasIpcBridge, unwrap, unwrapErrorMessage } from '@/lib/ipc';
import { clearAllSessions } from '@/lib/settings-ops';

import { useMutationOnError } from './use-mutation-error';

/**
 * Query key 常量（避免手写字符串导致 typo）
 *
 * ['sessions'] - 会话列表缓存
 * ['session', id] - 会话域失效/清理**前缀**（invalidate/removeQueries 用，
 *   前缀匹配覆盖详情全形状 + turns / turn-pages 分页域）
 * ['session', id, 'meta'|'full'] - 会话详情数据缓存（SESSION_DETAIL_DATA_KEY，
 *   按 includeMessages 分形状——同一缓存条目恒同形状，防「同 key 两种
 *   queryFn 互相覆盖」（2026-09-25 审查修复：此前双形状共用 ['session', id]）
 */
export const SESSIONS_QUERY_KEY = ['sessions'] as const;
export const SESSION_DETAIL_QUERY_KEY = (id: string) => ['session', id] as const;
export const SESSION_DETAIL_DATA_KEY = (id: string, includeMessages: boolean) =>
  includeMessages ? (['session', id, 'full'] as const) : (['session', id, 'meta'] as const);
/**
 * 会话域根前缀（36-D：removeQueries 用）——清空全部会话时详情/回合/最近目录
 * 缓存全部指向已删数据，按根前缀一次性移除（观察者挂载时自动重拉）
 */
export const SESSION_ROOT_QUERY_KEY = ['session'] as const;

/** 默认分页大小（一页 50 条） */
const DEFAULT_PAGE_SIZE = 50;

/** 会话列表缓存数据类型（单页形状；乐观更新与视图适配用） */
export type SessionListData = {
  readonly sessions: readonly SessionMeta[];
  readonly total: number;
};

/**
 * 会话列表分页原始拉取（useSessionsQuery 与 useSessionsFlat 共用同一 queryFn）
 *
 * 同 key 必须同 queryFn：两 hook 共享 ['sessions'] 缓存条目，queryFn 形状不一致
 * 会互相覆盖缓存（同 SESSION_DETAIL_DATA_KEY 双形状先例）。
 */
async function fetchSessionListPage({
  pageParam,
}: {
  pageParam: number;
}): Promise<SessionListData> {
  // E2E 浏览器模式下 window.api 未注入（无 preload），返回空列表
  if (!hasIpcBridge()) {
    return { sessions: [], total: 0 };
  }
  const response = await window.api.session.list({
    limit: DEFAULT_PAGE_SIZE,
    offset: pageParam,
  });
  return unwrap(response);
}

/** 下一页 offset = 已加载条数；已加载数达 total 时停止（两个 hook 共用） */
function sessionListNextPageParam(
  lastPage: SessionListData,
  allPages: readonly SessionListData[],
): number | undefined {
  const loaded = allPages.reduce((sum, page) => sum + page.sessions.length, 0);
  return loaded < lastPage.total ? loaded : undefined;
}

/** 平铺全部已加载页为会话数组（useSessionsFlat 的 select，模块级函数保证 select 身份稳定） */
function flattenSessionPages(data: InfiniteData<SessionListData>): readonly SessionMeta[] {
  return data.pages.flatMap((page) => page.sessions);
}

/**
 * 会话列表查询 hook（P3 修复：无限分页）
 *
 * 调用 session:list IPC 按页拉取（默认按 updatedAt 倒序，每页 50 条）。
 * 此前固定拉 50 条：会话超限时侧栏静默截断且无「加载更多」。
 * 现改为 useInfiniteQuery：data.pages 为分页数组，fetchNextPage 加载更多。
 *
 * 只消费平铺会话数组的调用方改用 {@link useSessionsFlat}（同 key 同 queryFn，
 * select 已平铺）；需要 pages/total 形状（乐观更新按页适配、缓存直读）的用本 hook。
 *
 * @returns InfiniteQuery 结果（data.pages 为分页数组）
 */
export function useSessionsQuery() {
  return useInfiniteQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: fetchSessionListPage,
    initialPageParam: 0,
    getNextPageParam: sessionListNextPageParam,
    // 不启用 maxPages（2026-09-27 读 @tanstack/query-core@5.102.8 实证）：maxPages
    // 在每次追加页时生效，裁「与拉取方向相反」的一端——fetchNextPage（forward，
    // infiniteQueryObserver.js:21-25）走 addToEnd，超限 slice(1) 丢弃
    // pages[0]/pageParams[0]（infiniteQueryBehavior.js:36-40 + utils.js:151-154）；
    // 普通 refetch 又从 oldPageParams[0] 起逐页重放（infiniteQueryBehavior.js:52-58），
    // 被裁页不会自愈。本查询单向 fetchNextPage，pages[0] 恰是最新一批会话（服务端
    // updatedAt 倒序、置顶在前），Sidebar 平铺全部 pages 渲染——被裁端正是用户可见
    // 数据。启用前提：接 fetchPreviousPage（backward 改裁尾端）或反转页序让最新页
    // 落在尾端，使被裁端不再是可见数据。
  });
}

/**
 * 会话列表平铺查询 hook（useSessionsQuery 的 select 投影，只消费平铺数组的调用方用）
 *
 * 同 key 同 queryFn（fetchSessionListPage / sessionListNextPageParam 共用）：与
 * useSessionsQuery 共享 ['sessions'] 缓存条目与失效；select 只作用于本观察者的
 * result.data（query-core createResult 按观察者应用 select），不改缓存、不影响
 * 其他观察者。分页控制不受影响：hasNextPage / isFetchingNextPage / fetchNextPage
 * 照常可用（Sidebar「加载更多」即依赖它们）。
 *
 * @returns 无限分页查询结果（data 为平铺后的 readonly SessionMeta[]，保持服务端排序）
 *
 * @example
 * ```tsx
 * const { data: sessions } = useSessionsFlat();
 * ```
 */
export function useSessionsFlat() {
  return useInfiniteQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: fetchSessionListPage,
    initialPageParam: 0,
    getNextPageParam: sessionListNextPageParam,
    select: flattenSessionPages,
  });
}

/**
 * 会话详情原始拉取函数（hook 与路由 loader 共用）
 *
 * 独立导出的原因：路由 loader（router.tsx）需在不渲染组件的前提下预取
 * 同 key 缓存——查询点与预取点必须引用同一 queryFn，保证缓存形状一致。
 *
 * P2-28：session:get 契约默认翻转为「仅元数据」，此处默认参数随之对齐；
 * 显式传 true 才把 includeMessages:true 发上 IPC（主进程返回全量消息）。
 *
 * @param includeMessages false（默认）时仅拉元数据（消息走 getTurnMessages
 *   增量，见 use-session-turns.ts）
 */
export async function fetchSessionDetail(id: string, includeMessages = false) {
  const response = await window.api.session.get({
    id,
    ...(includeMessages ? { includeMessages: true } : {}),
  });
  return unwrap(response);
}

/**
 * 会话详情查询 hook（默认仅元数据；传 true 返回完整消息历史）
 *
 * 调用 session:get IPC。消息历史走 use-session-turns.ts 按回合增量加载
 * （debt.md#d2），元数据消费方（ChatPage workingDir/lastRunStatus）不为
 * 全量消息付 IPC 负载（P2-28：主进程契约默认亦为按需加载）。
 *
 * @param id 会话 id（null 时跳过查询，避免无激活会话时请求）
 * @param includeMessages 是否返回消息历史（默认 false，按需加载）
 * @returns TanStack Query 结果
 *
 * @example
 * ```tsx
 * const { data: detail } = useSessionDetail(activeSessionId);
 * ```
 */
export function useSessionDetail(id: string | null, includeMessages = false) {
  return useQuery({
    queryKey: SESSION_DETAIL_DATA_KEY(id ?? 'unknown', includeMessages),
    queryFn: async () => {
      if (id === null) {
        // enabled: false 时不会执行，但 TS 无法推断分支不可达
        // 此处抛错仅用于类型守卫，运行时不会进入
        throw new Error('id is null');
      }
      return fetchSessionDetail(id, includeMessages);
    },
    // 仅当 id 不为 null 时启用查询
    enabled: id !== null,
  });
}

/**
 * 删除会话 mutation hook
 *
 * 调用 session:delete IPC，删除成功后自动 invalidate sessions 列表缓存。
 * 若删除的是当前激活会话，调用方应额外调用 clearActiveSession 清空 UI 状态。
 *
 * @returns TanStack Mutation 结果（mutate / mutateAsync / isPending 等）
 *
 * @example
 * ```tsx
 * const { mutate: deleteSession, isPending } = useDeleteSession();
 * const onDelete = (id: string) => {
 *   deleteSession(id, {
 *     onSuccess: () => {
 *       toast.success('会话已删除');
 *       if (activeSessionId === id) clearActiveSession();
 *     },
 *   });
 * };
 * ```
 */
export function useDeleteSession() {
  const queryClient = useQueryClient();
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async (id: string) => {
      const response = await window.api.session.delete({ id });
      return unwrap(response);
    },
    // 乐观更新：先本地移除，失败回滚（避免全量重拉的等待）
    // P3：缓存形状为 InfiniteData——按 pages 逐页过滤
    onMutate: async (id: string) => {
      await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
      const prev = queryClient.getQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY);
      if (prev !== undefined) {
        queryClient.setQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY, {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            sessions: page.sessions.filter((s) => s.id !== id),
          })),
        });
      }
      return { prev };
    },
    onError: (error, _id, context) => {
      // 回滚乐观更新，恢复原列表
      if (context?.prev !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.prev);
      }
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
    // 最终一致：无论成败都触发重新拉取（校验服务端真实状态）
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onSuccess: (_data, id) => {
      // 删除成功后彻底移除该会话的详情缓存（removeQueries 而非 invalidate）：
      // invalidate 只标记 stale，30s staleTime 内 deep-link 回到已删会话仍会命中
      // 旧缓存渲染出已删除的内容（debt.md#d2 关联的缓存生命周期缺口）。
      // gcTime 5min 只回收「无观察者」的缓存，不解决「数据已不存在」。
      void queryClient.removeQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(id) });
    },
  });
}

/**
 * 清空全部会话 mutation hook（36-D：破坏性批量操作）
 *
 * 调用 session:clearAll IPC。成功后**彻底移除** 'session' 前缀下全部缓存
 * （详情/回合历史/最近目录——清空场景逐 id removeQueries 不现实；recent-dirs
 * 被一并移除属有意，观察者挂载时自动重拉）；列表 ['sessions'] 由 onSettled
 * invalidate 重拉对齐服务端空态。激活会话的清理由调用方处理（clearActiveSession
 * + 导航回首页，对齐 Sidebar 删除激活会话的回落行为）。
 *
 * @example
 * ```tsx
 * const { mutateAsync: clearAll } = useClearAllSessions();
 * await clearAll(); // confirm 后调用
 * ```
 */
export function useClearAllSessions() {
  const queryClient = useQueryClient();
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async () => {
      return clearAllSessions();
    },
    onSuccess: () => {
      // 详情/回合/最近目录缓存指向已删除数据：removeQueries 而非 invalidate
      // （同 useDeleteSession 的 onSuccess 语义，放大到全量前缀）
      void queryClient.removeQueries({ queryKey: SESSION_ROOT_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
    // 最终一致：无论成败都重拉列表（校验服务端真实状态）
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

/**
 * 重命名会话 mutation hook
 *
 * 调用 session:rename IPC，重命名成功后自动 invalidate sessions 列表缓存。
 *
 * @returns TanStack Mutation 结果
 *
 * @example
 * ```tsx
 * const { mutateAsync: renameSession } = useRenameSession();
 * await renameSession({ id, title: '新标题' });
 * ```
 */
export function useRenameSession() {
  const queryClient = useQueryClient();
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async (params: { id: string; title: string }) => {
      const response = await window.api.session.rename(params);
      return unwrap(response);
    },
    // 乐观更新：先本地改标题，失败回滚（避免全量重拉的等待）
    // P3：缓存形状为 InfiniteData——按 pages 逐页替换
    onMutate: async (params: { id: string; title: string }) => {
      await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
      const prev = queryClient.getQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY);
      if (prev !== undefined) {
        queryClient.setQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY, {
          ...prev,
          pages: prev.pages.map((page) => ({
            ...page,
            sessions: page.sessions.map((s) =>
              s.id === params.id ? { ...s, title: params.title } : s,
            ),
          })),
        });
      }
      return { prev };
    },
    onError: (error, _params, context) => {
      // 回滚乐观更新，恢复原标题
      if (context?.prev !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.prev);
      }
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
    // 最终一致：无论成败都触发重新拉取（校验服务端真实状态）
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

/** 最近目录列表 query key */
export const RECENT_DIRS_QUERY_KEY = ['session', 'recent-dirs'] as const;

/**
 * 最近目录列表查询 hook
 *
 * 调用 session:listRecentDirs IPC 获取去重后的最近使用目录列表。
 * 用于 HomePage 欢迎页 composer-project-bar 的 folder dropdown 展示历史目录。
 */
export function useRecentDirs() {
  return useQuery({
    queryKey: RECENT_DIRS_QUERY_KEY,
    queryFn: async () => {
      if (!hasIpcBridge()) {
        return { dirs: [] };
      }
      const response = await window.api.session.listRecentDirs({ limit: 10 });
      return unwrap(response);
    },
  });
}

/**
 * 创建会话 mutation hook
 *
 * 调用 session:create IPC 创建新会话（绑定 workingDir）。
 * 成功后自动 invalidate sessions 列表 + recent-dirs 缓存。
 *
 * @returns TanStack Mutation 结果
 *
 * @example
 * ```tsx
 * const { mutateAsync: createSession } = useCreateSession();
 * const { sessionId } = await createSession({ workingDir: 'D:\\proj' });
 * navigate(ROUTES.chatPath(sessionId));
 * ```
 */
export function useCreateSession() {
  const queryClient = useQueryClient();
  const onError = useMutationOnError();

  return useMutation({
    mutationFn: async (params: { workingDir: string; title?: string }) => {
      const response = await window.api.session.create(params);
      return unwrap(response);
    },
    onSuccess: () => {
      // 失效会话列表 + 最近目录列表缓存
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
      void queryClient.invalidateQueries({ queryKey: RECENT_DIRS_QUERY_KEY });
    },
    onError,
  });
}

/**
 * 把某会话的 pinned 写入分页缓存（模块级纯函数：从 onMutate 提取）
 *
 * @returns 新缓存；old 为 undefined 时原样返回
 */
function applyPinnedToCache(
  old: InfiniteData<SessionListData> | undefined,
  id: string,
  pinned: boolean,
): InfiniteData<SessionListData> | undefined {
  if (old === undefined) return old;
  return {
    ...old,
    pages: old.pages.map((page) => ({
      ...page,
      sessions: page.sessions.map((s) => (s.id === id ? { ...s, pinned } : s)),
    })),
  };
}

/**
 * 置顶/取消置顶会话 mutation hook（对齐参考项目 pinned-header 分组）
 *
 * 调用 session:pin IPC，成功后 invalidate sessions 列表缓存（置顶会话排序在前）。
 */
export function usePinSession() {
  const queryClient = useQueryClient();
  const { getErrorMessage } = useErrorMessage();

  return useMutation({
    mutationFn: async (params: { id: string; pinned: boolean }) => {
      const response = await window.api.session.pin(params);
      return unwrap(response);
    },
    // 乐观更新：直接改缓存内对应会话的 pinned（实测 invalidate 的 refetch 在
    // 浏览器 mock 环境下时序不可靠，取消置顶后列表数据仍为旧值 → 会话不回文件夹）；
    // 成功后再 invalidate 兜底重拉对齐服务端排序
    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
      // 快照用于失败回滚（2026-09-08 修复：此前不返回 context，
      // IPC 失败时乐观值留在缓存里，置顶状态与 SQLite 不一致且用户无感知）
      const prev = queryClient.getQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY);
      queryClient.setQueryData(
        SESSIONS_QUERY_KEY,
        (old: InfiniteData<SessionListData> | undefined) =>
          applyPinnedToCache(old, params.id, params.pinned),
      );
      return { prev };
    },
    onError: (error, _params, context) => {
      // 回滚乐观更新，恢复原列表
      if (context?.prev !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.prev);
      }
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    },
    // 最终一致：无论成败都触发重新拉取（置顶分组重排）
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
  });
}

/**
 * 会话列表类型导出（从 query result 派生）
 *
 * 业务方从此处导入 SessionMeta，避免直接依赖 shared 包。
 */
export type { SessionMeta };
