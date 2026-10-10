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
        throw new Error('id is null');
      }
      return fetchSessionDetail(id, includeMessages);
    },
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
      if (context?.prev !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.prev);
      }
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onSuccess: (_data, id) => {
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
      void queryClient.removeQueries({ queryKey: SESSION_ROOT_QUERY_KEY });
    },
    onError: (error) => {
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
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
      if (context?.prev !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.prev);
      }
      toast.error(unwrapErrorMessage(error as Error, getErrorMessage));
    },
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
    onMutate: async (params) => {
      await queryClient.cancelQueries({ queryKey: SESSIONS_QUERY_KEY });
      const prev = queryClient.getQueryData<InfiniteData<SessionListData>>(SESSIONS_QUERY_KEY);
      queryClient.setQueryData(
        SESSIONS_QUERY_KEY,
        (old: InfiniteData<SessionListData> | undefined) =>
          applyPinnedToCache(old, params.id, params.pinned),
      );
      return { prev };
    },
    onError: (error, _params, context) => {
      if (context?.prev !== undefined) {
        queryClient.setQueryData(SESSIONS_QUERY_KEY, context.prev);
      }
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    },
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
