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
  const { t } = useTranslation();
  const { getErrorMessage } = useErrorMessage();
  const { data: session, isLoading, isError } = useSessionDetail(sessionId, false);
  const turnsQuery = useSessionTurns(sessionId);
  const history = useTurnMessagesInfinite(sessionId, turnsQuery.data?.turns);
  const pagesQuery = useTurnPagesInfinite(sessionId, turnsQuery.data?.turns);
  const workingDir = useWorkingDir(sessionId, session?.session.workingDir);
  const setWelcomeMode = useWelcomeStore((state) => state.setWelcomeMode);

  useEffect(() => {
    setWelcomeMode(false);
  }, [setWelcomeMode]);

  const shownTurnIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const page of pagesQuery.data?.pages ?? []) {
      for (const group of page.turns) {
        shownTurnIdsRef.current.add(group.turnId);
      }
    }
  }, [pagesQuery.data]);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = pagesQuery;
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

  if (turnsQuery.isError || history.isError) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <p>{t('common.chatLoadFailed')}</p>
      </div>
    );
  }

  const historyReady = turnsQuery.isSuccess && history.isSuccess;
  if (isLoading || !historyReady) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        {t('common.loading')}
      </div>
    );
  }

  if (session === undefined || isError) {
    return <Navigate to={ROUTES.home} replace />;
  }

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
      initialMessages={history.data}
      {...(hasNextPage ? { hasEarlier: true } : {})}
      {...(isFetchingNextPage ? { loadingEarlier: true } : {})}
      {...(hasNextPage ? { loadEarlier } : {})}
    />
  );
}
