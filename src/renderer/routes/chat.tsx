// src/renderer/routes/chat.tsx
// 聊天页路由组件
// ──────────────────────────────────────────────────────────────
// 职责：
// - 从 URL 参数读取 sessionId
// - 渲染 ChatPanel，传入 chatId（控制 useChat 状态隔离）
// - 路由无效（sessionId 缺失）时重定向到首页
//
// 设计：
// - 不在此组件直接调用 IPC（持久化由 AgentService 在流式推送过程中完成）
// - onFinish 留空：消息落库由 AgentService 通过 chat:stream:end 事件触发
// - ChatPanel 内部 useChatWithIpc 已注入 IpcChatTransport
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { Navigate, useParams } from 'react-router';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { ROUTES } from '@/lib/constants';

/**
 * 聊天页路由组件
 *
 * URL 模式：/chat/:sessionId
 *
 * 通过 useParams 读取 sessionId 传给 ChatPanel 作为 chatId：
 * - chatId 是 useChat 的 id 参数，控制消息状态隔离
 * - 切换 sessionId 时，useChat 会自动重置为对应会话的消息
 *
 * 若 URL 不含 sessionId（不应发生，但类型守卫），重定向到首页。
 *
 * @example
 * ```tsx
 * // router.tsx
 * { path: ROUTES.chat, element: <ChatPage /> }
 * ```
 */
export function ChatPage(): ReactElement {
  const { sessionId } = useParams<{ sessionId: string }>();

  // 类型守卫：sessionId 缺失时重定向到首页（不应发生，路由匹配保证存在）
  if (sessionId === undefined) {
    return <Navigate to={ROUTES.home} replace />;
  }

  return <ChatPanel chatId={sessionId} />;
}

export default ChatPage;
export const Component = ChatPage;
