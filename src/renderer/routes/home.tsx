// src/renderer/routes/home.tsx
// 应用首页 · 新对话草稿区
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 ChatPanel（chatId='draft'），让用户进入应用即可开始对话
// - 不展示欢迎占位文案（保留极简沉浸式对话体验，参考 ChatGPT/Claude）
//
// 设计：
// - chatId='draft' 是固定值，用于 useChat 状态隔离
// - 用户在首页发送首条消息后，主进程 AgentService 会创建真实会话
//   并通过 chat:stream:end 推送 sessionId
// - 未来 P9 将监听 sessionId 推送，自动 replace URL 到 /chat/:real-id
//   （当前阶段 URL 保持 / 不变，刷新页面会丢失上下文）
//
// 与 /chat/:sessionId 路由的差异：
// - / 路由：chatId='draft'，表示新对话草稿（无对应 SQLite 记录）
// - /chat/:sessionId 路由：chatId=sessionId，表示历史会话续传
// - 两者都渲染 ChatPanel，仅 chatId 不同，useChat 自动隔离状态
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';

import { ChatPanel } from '@/components/chat/ChatPanel';
import { DRAFT_SESSION_ID } from '@/lib/constants';

/**
 * 应用首页组件
 *
 * 直接渲染 ChatPanel，让用户进入应用即可开始对话。
 * 不展示欢迎占位文案，保持沉浸式对话体验。
 *
 * chatId 使用 DRAFT_SESSION_ID（'draft'），与 AppShell 中 DevPanel 的 sessionId
 * 保持一致，确保首页草稿态也能复用同一个草稿终端实例。
 */
export function HomePage(): ReactElement {
  return <ChatPanel chatId={DRAFT_SESSION_ID} />;
}

export default HomePage;
export const Component = HomePage;
