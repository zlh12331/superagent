// src/renderer/routes/chat.tsx
// 聊天页路由组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 URL 参数读取 sessionId
// - 通过 useSessionDetail 获取 session.workingDir
// - 渲染 ChatPanel，传入 chatId + workingDir
// - session 不存在或 workingDir 为空时重定向到首页
// - 进入时退出欢迎页模式（确保从 HomePage navigate 过来后 welcome-mode class 移除）
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useEffect } from 'react';
import { Navigate, useParams } from 'react-router';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { useSessionDetail } from '@/hooks/use-sessions';
import { useTranslation } from '@/i18n/use-translation';
import { ROUTES } from '@/lib/constants';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

/**
 * 聊天页路由组件
 *
 * URL 模式：/chat/:sessionId
 *
 * 通过 useParams 读取 sessionId，再通过 useSessionDetail 拉取会话详情，
 * 提取 workingDir 注入 ChatPanel（Agent 模式的工具操作边界）。
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
 * 内部组件：sessionId 已确定，查询会话详情后渲染 ChatPanel
 *
 * 拆分原因：useSessionDetail 必须 unconditional 调用（hooks 规则），
 * 因此在 sessionId 确定后调用，避免条件 hook。
 */
function ChatPageInner({ sessionId }: { sessionId: string }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  const { data: session, isLoading } = useSessionDetail(sessionId);
  const setWelcomeMode = useWelcomeStore((state) => state.setWelcomeMode);

  // 进入聊天页时退出欢迎页模式（兜底：HomePage 已调用 exitWelcomeMode，
  // 此处确保直接通过 URL 访问 /chat/:id 时也能正确移除 welcome-mode class）
  useEffect(() => {
    setWelcomeMode(false);
  }, [setWelcomeMode]);

  // loading 中：显示加载状态
  if (isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        {t('common.loading')}
      </div>
    );
  }

  // session 不存在（已被删除或 URL 伪造）：重定向到首页
  if (session === undefined) {
    return <Navigate to={ROUTES.home} replace />;
  }

  // workingDir 为空（旧 chat 会话兼容，数据异常）：显示错误状态
  if (session.session.workingDir === '') {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center">
        <p>{t('common.chatLoadFailed')}</p>
      </div>
    );
  }

  return (
    <ChatPanel
      chatId={sessionId}
      workingDir={session.session.workingDir}
      interrupted={session.session.lastRunStatus === 'interrupted'}
    />
  );
}

export default ChatPage;
export const Component = ChatPage;
