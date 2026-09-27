// src/renderer/routes/chat.tsx
// 聊天页路由组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 URL 参数读取 sessionId
// - 元数据经 useSessionDetail({ includeMessages: false })（workingDir/lastRunStatus）
// - 历史消息按回合增量加载（useSessionTurns + useTurnMessagesInfinite，
//   debt.md#d2/#d4）：首屏仅取最近一页回合的消息，滚动到顶再拉更早页
// - 渲染 ChatPanel，传入 chatId + workingDir + initialMessages + 向上补页回调
// - session 不存在或 workingDir 为空时重定向到首页
// - 进入时退出欢迎页模式（确保从 HomePage navigate 过来后 welcome-mode class 移除）
// ──────────────────────────────────────────────────────────────

import type { ChatMessage } from '@code-agent/shared/renderer';
import { type ReactElement, useEffect, useRef } from 'react';
import { Navigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { ChatPanel } from '@/components/chat/ChatPanel';
import {
  useSessionTurns,
  useTurnMessagesInfinite,
  useTurnPagesInfinite,
} from '@/hooks/use-session-turns';
import { useSessionDetail } from '@/hooks/use-sessions';
import { useWorkingDir } from '@/hooks/use-working-dir';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { unwrapErrorMessage } from '@/lib/ipc';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

/**
 * 聊天页路由组件
 *
 * URL 模式：/chat/:sessionId
 *
 * 通过 useParams 读取 sessionId，再通过 useSessionDetail 拉取会话详情，
 * 提取 workingDir 注入 ChatPanel（Agent 模式的工具操作边界），
 * 并把历史消息（ChatMessage[] = ModelMessage[]）作为 initialMessages
 * 注入 useChat——历史会话打开即可回显消息（此前缺口）。
 *
 * 若 URL 不含 sessionId（不应发生，但类型守卫），重定向到首页。
 */
export function ChatPage(): ReactElement {
  const { sessionId } = useParams<{ sessionId: string }>();

  // 类型守卫：sessionId 缺失时重定向到首页（不应发生，路由匹配保证存在）
  if (sessionId === undefined) {
    return <Navigate to={ROUTES.home} replace />;
  }

  return <ChatPageInner sessionId={sessionId} />;
}

/**
 * 内部组件：sessionId 已确定，装配数据后渲染 ChatPanel
 *
 * 拆分原因：hooks 必须 unconditional 调用（hooks 规则），
 * 因此在 sessionId 确定后调用，避免条件 hook。
 *
 * 数据装配（debt.md#d2/#d4）：
 * - 元数据：useSessionDetail(id, false)（workingDir / lastRunStatus，免付全量消息负载）
 * - 回合列表：useSessionTurns（摘要，一次全量）
 * - 消息体：useTurnMessagesInfinite（select 平铺，data 即时间正序消息数组）+
 *   useTurnPagesInfinite（原始分页形状镜像：shownTurnIdsRef 注册与 loadEarlier
 *   去重按回合身份 turnId，平铺 ChatMessage 不带 turnId 表达不了）
 */
function ChatPageInner({ sessionId }: { sessionId: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const { data: session, isLoading, isError } = useSessionDetail(sessionId, false);
  const turnsQuery = useSessionTurns(sessionId);
  // 平铺消息（select 单一口径：data 即时间正序去重后的 ChatMessage[]）
  const history = useTurnMessagesInfinite(sessionId, turnsQuery.data?.turns);
  // 原始分页形状镜像（同 key 同 queryFn，select 各观察者独立应用）：注册与去重
  // 按 turnId 走它，平铺数组表达不了回合身份
  const pagesQuery = useTurnPagesInfinite(sessionId, turnsQuery.data?.turns);
  // 唯一权威入口：详情已到位时以详情值为权威，否则回落会话列表索引
  const workingDir = useWorkingDir(sessionId, session?.session.workingDir);
  const setWelcomeMode = useWelcomeStore((state) => state.setWelcomeMode);

  // 进入聊天页时退出欢迎页模式（兜底：HomePage 已调用 exitWelcomeMode，
  // 此处确保直接通过 URL 访问 /chat/:id 时也能正确移除 welcome-mode class）
  useEffect(() => {
    setWelcomeMode(false);
  }, [setWelcomeMode]);

  // 向上补页回调（hooks 规则：须在早退 return 之前声明）：拉取更早一页并返回
  // 其消息（ChatPanel prepend 后锚定由列表层处理）。
  // shownTurnIdsRef 注册 UI 已显示/即将显示的回合（幂等）：翻页与回合结束
  // invalidate 的交错窗口里，fetchNextPage 返回页可能与已显示页重叠——
  // 返回前按回合身份过滤，防重复 prepend（2026-09-25 审查修复）。
  const shownTurnIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const page of pagesQuery.data?.pages ?? []) {
      for (const group of page.turns) {
        shownTurnIdsRef.current.add(group.turnId);
      }
    }
  }, [pagesQuery.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pagesQuery;
  // 引用稳定性交给 React Compiler（捕获分页状态与回调）
  const loadEarlier = async (): Promise<readonly ChatMessage[] | null> => {
    if (!hasNextPage) {
      return null;
    }
    try {
      const result = await fetchNextPage();
      const pages = result.data?.pages;
      const oldestPage = pages?.[pages.length - 1];
      if (oldestPage === undefined) {
        return null;
      }
      const fresh = oldestPage.turns.filter((group) => !shownTurnIdsRef.current.has(group.turnId));
      for (const group of fresh) {
        shownTurnIdsRef.current.add(group.turnId);
      }
      return fresh.flatMap((group) => group.messages);
    } catch (error) {
      toast.error(
        unwrapErrorMessage(
          error instanceof Error ? error : new Error(String(error)),
          getErrorMessage,
        ),
      );
      return null;
    }
  };

  // 回合列表 / 消息分页查询失败（历史拉取出错）：显示错误状态。
  // 必须先于 loading 判定：isSuccess 与 isError 互斥，isError 时 historyReady
  // 恒为 false，若 loading 分支在前会吞掉错误态（实测：任何历史查询失败都
  // 永久卡「加载中」，下方错误分支成死代码——2026-09-25 审查修复）。
  if (turnsQuery.isError || history.isError) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <p>{t('common.chatLoadFailed')}</p>
      </div>
    );
  }

  // loading 中：显示加载状态（元数据 / 回合列表 / 首页消息任一未就绪）
  const historyReady = turnsQuery.isSuccess && history.isSuccess;
  if (isLoading || !historyReady) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        {t('common.loading')}
      </div>
    );
  }

  // session 不存在（已被删除或 URL 伪造）：重定向到首页。
  // isError 必须显式检查：被删会话的详情缓存已 removeQueries，重查返回错误而非
  // undefined 数据——不检查会让错误态落在所有守卫之外。
  if (session === undefined || isError) {
    return <Navigate to={ROUTES.home} replace />;
  }

  // 回合列表 / 消息分页查询失败（历史拉取出错）：显示错误状态
  if (turnsQuery.isError || history.isError) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <p>{t('common.chatLoadFailed')}</p>
      </div>
    );
  }

  // workingDir 未知（旧 chat 会话空目录兼容 / 列表与详情都无数据）：显示错误状态
  if (workingDir === null) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <p>{t('common.chatLoadFailed')}</p>
      </div>
    );
  }

  return (
    <ChatPanel
      chatId={sessionId}
      workingDir={workingDir}
      interrupted={session.session.lastRunStatus === 'interrupted'}
      // 历史消息注入 useChat（useTurnMessagesInfinite 的 select 已平铺去重；
      // 向上补页经 loadEarlier）
      initialMessages={history.data}
      {...(hasNextPage ? { hasEarlier: true } : {})}
      {...(isFetchingNextPage ? { loadingEarlier: true } : {})}
      {...(hasNextPage ? { loadEarlier } : {})}
    />
  );
}
