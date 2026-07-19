// src/renderer/routes/chat.tsx
// AI 对话路由占位
// 设计文档 §3 路由结构 + §5.1 场景 3 AI 流式对话
//
// 职责：
// - 展示聊天会话列表 + 消息流（占位）
// - 后续 Phase 8 将接入 chat-stream.store + IPC onStreamChunk 订阅

import type { ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** AI 对话页面（占位） */
export function Component(): ReactElement {
  return (
    <div className="p-6">
      <Card>
        <CardHeader>
          <CardTitle>AI 对话</CardTitle>
          <CardDescription>Phase 8 实现：会话列表 + 流式消息（SSE 风格）</CardDescription>
        </CardHeader>
        <CardContent className="text-muted-foreground text-sm">
          此处将展示聊天会话列表与消息流，支持流式接收 AI 回复， 通过 chat-stream.store 累积 chunk
          并实时渲染。
        </CardContent>
      </Card>
    </div>
  );
}

Component.displayName = 'ChatPage';
