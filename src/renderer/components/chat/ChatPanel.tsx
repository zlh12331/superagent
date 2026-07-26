// src/renderer/components/chat/ChatPanel.tsx
// 聊天面板主容器 · 集成 useAgentWithIpc + ChatMessageList + ChatInput
// ──────────────────────────────────────────────────────────────
// 职责：
// - 调用 useAgentWithIpc 获取 useChat 完整状态（Agent 模式）
// - 透传 messages / status 给 ChatMessageList
// - 透传 status + sendMessage + stop 给 ChatInput
// - 错误处理：onError 回调统一 toast 提示
//
// 设计：
// - 三段式布局：顶部标题栏 / 中间消息列表 / 底部输入框
// - workingDir 为必填 prop（Agent 工具操作边界）
// - 工具调用已 inline 渲染在 ChatMessageList（ToolCallView）
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useCallback } from 'react';
import { toast } from 'sonner';

import { useAgentWithIpc } from '@/hooks/use-agent';
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
   * 项目工作目录（必填）
   *
   * Agent 工具操作的根目录，每个会话绑定独立 workingDir。
   * 由路由层（chat.tsx）从 session.workingDir 注入。
   */
  workingDir: string;
  /** 自定义容器类名 */
  className?: string;
}

/**
 * 聊天面板主容器
 *
 * 三段式布局（顶栏 / 消息列表 / 输入框），集成 useAgentWithIpc。
 *
 * Agent 模式特性：
 * - 多轮工具调用（走 agent:run IPC）
 * - 工具调用以 inline 卡片渲染在 ChatMessageList（ToolCallView）
 * - 消息持久化由 AgentService 在流式推送过程中完成，无需 onFinish 回调
 *
 * @example
 * ```tsx
 * <ChatPanel chatId={sessionId} workingDir={session.workingDir} />
 * ```
 */
export function ChatPanel({ chatId, workingDir, className }: ChatPanelProps): ReactElement {
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

  // useAgentWithIpc：Agent 模式专用 hook
  // - id: 控制消息状态隔离
  // - workingDir: agent 工具操作边界（注入 IpcAgentTransport）
  // - onError: 统一 toast 提示（不阻塞 UI）
  // - regenerate: AI SDK v7 内置，自动截断目标 assistant 消息及后续 → 重发请求
  const { messages, sendMessage, status, stop, regenerate } = useAgentWithIpc({
    id: chatId,
    workingDir,
    onError: handleError,
  });

  // 派生：workingDir basename（用于状态条展示，避免显示完整路径污染视觉）
  const workingDirBasename = workingDir.split(/[\\/]/).pop() ?? workingDir;

  // 派生：状态指示文本（用于状态条右侧）
  const statusText =
    status === 'streaming'
      ? 'RUNNING'
      : status === 'submitted'
        ? 'THINKING'
        : status === 'ready'
          ? 'READY'
          : status === 'error'
            ? 'ERROR'
            : 'IDLE';

  // 重新生成回调：透传给 ChatMessageList → MsgActions
  // useChat.regenerate({ messageId }) 会自动移除该 assistant 消息及后续所有消息，
  // 然后用截断后的 messages 重新发起请求（transport 复用同一 sessionId，AgentService 自动中断旧 stream）
  const handleRegenerate = useCallback(
    (messageId: string) => {
      void regenerate({ messageId });
    },
    [regenerate],
  );

  return (
    <div className={cn('flex h-full flex-col', className)}>
      {/* 顶部状态条：等宽字体遥测带（workingDir + status 指示器）
          - 左侧：项目目录 basename（限制宽度，溢出省略）
          - 右侧：当前状态（READY/RUNNING/THINKING/ERROR/IDLE）+ 会话 id 前 8 位 */}
      <div className="thread-status-bar">
        <div className="min-w-0 flex-1 truncate" title={workingDir}>
          {workingDirBasename}
        </div>
        <span className="text-muted-foreground/70" aria-hidden="true">
          ·
        </span>
        <div
          className={cn(
            'inline-flex items-center gap-1.5',
            status === 'streaming' && 'text-[var(--aurora-accent)]',
            status === 'error' && 'text-destructive',
          )}
          role="status"
          aria-label={`会话状态：${statusText}`}
        >
          {/* 状态点：streaming 时脉冲动画 */}
          <span
            className={cn(
              'inline-block size-1.5 rounded-full bg-current',
              status === 'streaming' && 'animate-pulse-soft',
            )}
          />
          {statusText}
        </div>
      </div>

      {/* 中间消息列表 */}
      <div className="min-h-0 flex-1">
        <ChatMessageList messages={messages} status={status} onRegenerate={handleRegenerate} />
      </div>

      {/* 底部输入框：.composer 提供顶部渐变 + padding，内部 .composer-box 由 ChatInput 渲染 */}
      <footer className="composer">
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
