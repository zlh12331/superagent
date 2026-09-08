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
import { unwrap, unwrapErrorMessage } from '@/lib/ipc';

/**
 * Query key 常量（避免手写字符串导致 typo）
 *
 * ['sessions'] - 会话列表缓存
 * ['session', id] - 单个会话详情缓存
 */
export const SESSIONS_QUERY_KEY = ['sessions'] as const;
export const SESSION_DETAIL_QUERY_KEY = (id: string) => ['session', id] as const;

/** 默认分页大小（一页 50 条） */
const DEFAULT_PAGE_SIZE = 50;

/** 会话列表缓存数据类型（单页形状；乐观更新与视图适配用） */
export type SessionListData = {
  readonly sessions: readonly SessionMeta[];
  readonly total: number;
};

/**
 * 会话列表查询 hook（P3 修复：无限分页）
 *
 * 调用 session:list IPC 按页拉取（默认按 updatedAt 倒序，每页 50 条）。
 * 此前固定拉 50 条：会话超限时侧栏静默截断且无「加载更多」。
 * 现改为 useInfiniteQuery：消费方用 data.pages 平铺 + fetchNextPage 加载更多。
 *
 * @returns InfiniteQuery 结果（data.pages 为分页数组）
 *
 * @example
 * ```tsx
 * const query = useSessionsQuery();
 * const sessions = query.data?.pages.flatMap((p) => p.sessions) ?? [];
 * ```
 */
export function useSessionsQuery() {
  return useInfiniteQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async ({ pageParam }) => {
      // E2E 浏览器模式下 window.api 未注入（无 preload），返回空列表
      if (typeof window === 'undefined' || window.api === undefined) {
        return { sessions: [], total: 0 };
      }
      const response = await window.api.session.list({
        limit: DEFAULT_PAGE_SIZE,
        offset: pageParam,
      });
      return unwrap(response);
    },
    initialPageParam: 0,
    // 下一页 offset = 已加载条数；已加载数达 total 时停止
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.sessions.length, 0);
      return loaded < lastPage.total ? loaded : undefined;
    },
  });
}

/**
 * 会话详情查询 hook（含完整消息历史）
 *
 * 调用 session:get IPC 获取指定会话的完整消息历史。
 * 用于用户切换到某个历史会话时，加载该会话的 messages。
 *
 * @param id 会话 id（null 时跳过查询，避免无激活会话时请求）
 * @returns TanStack Query 结果
 *
 * @example
 * ```tsx
 * const { data: detail } = useSessionDetail(activeSessionId);
 * if (detail) {
 *   // 把 detail.messages 传给 useChat 初始化
 * }
 * ```
 */
export function useSessionDetail(id: string | null) {
  return useQuery({
    queryKey: SESSION_DETAIL_QUERY_KEY(id ?? 'unknown'),
    queryFn: async () => {
      if (id === null) {
        // enabled: false 时不会执行，但 TS 无法推断分支不可达
        // 此处抛错仅用于类型守卫，运行时不会进入
        throw new Error('id is null');
      }
      const response = await window.api.session.get({ id });
      return unwrap(response);
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
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
    },
    // 最终一致：无论成败都触发重新拉取（校验服务端真实状态）
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
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
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
      if (typeof window === 'undefined' || window.api === undefined) {
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
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
    },
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
