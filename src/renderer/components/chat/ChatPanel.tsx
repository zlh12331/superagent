// src/renderer/components/chat/ChatPanel.tsx
// 聊天面板主容器 · 集成 useChat + ChatMessageList + ChatInput
// ──────────────────────────────────────────────────────────────
// 职责：
// - 调用 useChatWithIpc 获取 useChat 完整状态
// - 透传 messages / status 给 ChatMessageList
// - 透传 status + sendMessage + stop 给 ChatInput
// - 错误处理：onError 回调统一 toast 提示（不阻塞 UI，仅展示）
// - onFinish 回调：可选，父组件用于持久化消息到 SQLite
//
// 设计：
// - 三段式布局：顶部标题栏 / 中间消息列表 / 底部输入框
// - 顶部标题栏使用 muted 背景，分隔线分明
// - 消息列表 flex-1 + overflow，输入框底部 sticky
// - 文学风：衬线字体 + 米色背景 + 圆角
// ──────────────────────────────────────────────────────────────
//
// 说明：
// - chatId 用于 useChat 的 id 参数，控制消息状态隔离
// - 多会话场景下，父组件切换 chatId 即可重置 useChat 状态
// - onFinish 回调用于父组件持久化（如调用 session:appendMessage IPC）
//
// 错误处理策略：
// - 仅在 onError 回调中处理（一次性触发，避免双 toast）
// - 优先尝试从 error.message 提取 [CODE] 前缀匹配 i18n 文案
// - 兜底：直接展示原始 error.message

import { type ReactElement, useCallback } from 'react';
import { toast } from 'sonner';

import { useChatWithIpc } from '@/hooks/use-chat';
import { useErrorMessage } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

import { ChatInput } from './ChatInput';
import { ChatMessageList } from './ChatMessageList';

interface ChatPanelProps {
  /**
   * 对话 id（用于 useChat 的 id 参数，控制消息状态隔离）
   *
   * 不同 chatId 拥有独立的 messages 状态，互不干扰。
   * 父组件切换 chatId 时，useChat 会自动重置为对应会话的消息。
   */
  chatId: string;
  /**
   * 对话结束回调（可选）
   *
   * 当 useChat 进入 onFinish 时触发，父组件可在此持久化消息。
   */
  onFinish?: () => void;
  /** 自定义容器类名 */
  className?: string;
}

/**
 * 聊天面板主容器
 *
 * 三段式布局（顶栏 / 消息列表 / 输入框），集成 useChat。
 *
 * @example
 * ```tsx
 * <ChatPanel chatId={activeSessionId ?? 'new'} />
 * ```
 */
export function ChatPanel({ chatId, onFinish, className }: ChatPanelProps): ReactElement {
  // 错误码 → 本地化文案 hook
  const { getErrorMessage } = useErrorMessage();

  // 错误处理回调：一次性触发，避免 useEffect 双 toast
  // 策略：尝试从 error.message 提取 [CODE] 前缀匹配 i18n 文案，失败则展示原始消息
  const handleError = useCallback(
    (error: Error) => {
      // 尝试从 error.message 提取错误码（格式 "[CODE] message"）
      const codeMatch = /^\[([A-Z_]+)\]/.exec(error.message);
      if (codeMatch !== null) {
        const code = codeMatch[1] as Parameters<typeof getErrorMessage>[0];
        toast.error(getErrorMessage(code));
      } else {
        // 兜底：直接展示原始 error.message
        toast.error(error.message);
      }
    },
    [getErrorMessage],
  );

  // useChat 封装：注入 IPC transport
  // - id: 控制消息状态隔离
  // - onError: 统一 toast 提示（不阻塞 UI）
  // - onFinish: 透传给父组件
  //
  // 注意：AI SDK v7 的 ChatOnErrorCallback 签名为 (error: Error) => void，
  // 参数直接是 Error 实例（不是事件对象），访问 error.message 即可。
  const { messages, sendMessage, status, stop } = useChatWithIpc({
    id: chatId,
    onError: handleError,
    onFinish: () => {
      onFinish?.();
    },
  });

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* 顶部标题栏 */}
      <header className="border-border bg-muted/30 border-b px-4 py-2">
        <span className="text-foreground font-serif text-sm font-medium tracking-wide">对话</span>
      </header>

      {/* 中间消息列表 */}
      <div className="min-h-0 flex-1">
        <ChatMessageList messages={messages} status={status} />
      </div>

      {/* 底部输入框 */}
      <footer className="border-border border-t p-3">
        <ChatInput
          status={status}
          onSend={(text) => {
            // sendMessage 接受 { text: string } 格式
            void sendMessage({ text });
          }}
          onStop={() => {
            // stop 是同步操作，但返回 Promise（兼容 abortSignal）
            void stop();
          }}
        />
      </footer>
    </div>
  );
}
