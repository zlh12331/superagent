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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

/**
 * Query key 常量（避免手写字符串导致 typo）
 *
 * ['sessions'] - 会话列表缓存
 * ['session', id] - 单个会话详情缓存
 */
export const SESSIONS_QUERY_KEY = ['sessions'] as const;
export const SESSION_DETAIL_QUERY_KEY = (id: string) => ['session', id] as const;

/** 默认分页大小（一次拉取 50 条，足够侧栏展示） */
const DEFAULT_PAGE_SIZE = 50;

/**
 * 会话列表查询 hook
 *
 * 调用 session:list IPC 获取 SQLite 中持久化的会话列表。
 * 默认按 updatedAt 倒序排列，每页 50 条。
 *
 * @returns TanStack Query 结果（data / isLoading / error / refetch 等）
 *
 * @example
 * ```tsx
 * const { data: sessions, isLoading } = useSessionsQuery();
 * if (isLoading) return <Loading />;
 * return sessions?.map((s) => <SessionItem key={s.id} session={s} />);
 * ```
 */
export function useSessionsQuery() {
  return useQuery({
    queryKey: SESSIONS_QUERY_KEY,
    queryFn: async () => {
      // E2E 浏览器模式下 window.api 未注入（无 preload），返回空列表
      if (typeof window === 'undefined' || window.api === undefined) {
        return { sessions: [], total: 0 };
      }
      const response = await window.api.session.list({
        limit: DEFAULT_PAGE_SIZE,
        offset: 0,
      });
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      // 不可达：IpcResponse 是 discriminated union，必然有 error 或 data
      throw new Error('Unexpected response: missing data and error');
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
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response: missing data and error');
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
      // IpcResponse 是 discriminated union：
      // - 'error' in response → 错误分支，throw 让 mutation 进入 onError
      // - 否则 → data 分支，TS 自动收窄类型
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      // 失效会话列表缓存，触发重新拉取
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onError: (error) => {
      // 错误处理：toast 提示
      // 提取错误消息（格式为 [CODE] message，包含足够上下文供用户排查）
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
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
      // IpcResponse 是 discriminated union：
      // - 'error' in response → 错误分支，throw 让 mutation 进入 onError
      // - 否则 → data 分支，TS 自动收窄类型
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
    },
    onSuccess: () => {
      // 失效会话列表缓存，触发重新拉取
      void queryClient.invalidateQueries({ queryKey: SESSIONS_QUERY_KEY });
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(message);
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
      if ('error' in response && response.error !== undefined) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      throw new Error('Unexpected response: missing data and error');
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
      if ('error' in response) {
        throw new Error(`[${response.error.code}] ${response.error.message}`);
      }
      return response.data;
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
 * 会话列表类型导出（从 query result 派生）
 *
 * 业务方从此处导入 SessionMeta，避免直接依赖 shared 包。
 */
export type { SessionMeta };
