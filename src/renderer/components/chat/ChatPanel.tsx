import type { ChatMessage } from '@code-agent/shared/renderer';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { InlineApprovalCard } from '@/components/agent/inline-approval-card';
import { ModelSelector } from '@/components/common/ModelSelector';
import { useAgentWithIpc } from '@/hooks/use-agent';
import { useConversationSearch } from '@/hooks/use-conversation-search';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useAgentRunStore } from '@/stores/transient/agent-run-store';
import { usePendingMessageStore } from '@/stores/transient/pending-message-store';
import { useTurnErrorStore } from '@/stores/transient/turn-error-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { ChatInput } from './ChatInput';
import { ChatMessageList } from './ChatMessageList';
import { collectHistoryNotices, prependEarlierPage, statusLabel } from './chat-panel-derives';
import { ChatStatusBar } from './chat-status-bar';
import { ConversationSearchBar } from './conversation-search-bar';
import { GoalBar } from './GoalBar';
import { reconstructHistory, toInitialMessages } from './history-parts';
import { PanelNotice } from './panel-notice';
import { RateLimitBanner } from './rate-limit-banner';
import { TurnErrorNotice } from './turn-error-notice';
import { useAutoCompact } from './use-auto-compact';
import { createChatComposerActions } from './use-chat-composer-actions';
import { useChatGoals } from './use-chat-goals';
import { useSessionCompact } from './use-session-compact';

/** 稳定空数组：initialMessages 未传时复用同一引用，避免每轮渲染重算历史 */
const NO_STORED_MESSAGES: readonly ChatMessage[] = [];

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
  /**
   * 历史消息（ChatMessage[] = ModelMessage[]，来自回合分页首屏）
   *
   * 转换为 UIMessage 后作为 useChat 的 messages（v7 字段名）注入，
   * 打开历史会话时回显消息；仅在组件首次挂载时生效。空数组表示新会话。
   */
  initialMessages?: readonly ChatMessage[];
  /** 是否仍有更早回合未加载（滚动到顶触发 loadEarlier 向上补页） */
  hasEarlier?: boolean;
  /** 更早回合加载中（顶部指示条） */
  loadingEarlier?: boolean;
  /**
   * 加载更早一页回合消息（返回该页 ChatMessage[]，无更早/失败返回 null）；
   * 加载结果由本组件 prepend 进 messages（toInitialMessages 重建）
   */
  loadEarlier?: () => Promise<readonly ChatMessage[] | null>;
  /**
   * 上次回合是否异常中断（崩溃恢复：由路由层从 session.lastRunStatus 注入）
   * 为 true 时顶部展示"上次回合已中断"提示条
   */
  interrupted?: boolean;
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
export function ChatPanel({
  chatId,
  workingDir,
  initialMessages,
  hasEarlier = false,
  loadingEarlier = false,
  loadEarlier,
  interrupted = false,
  className,
}: ChatPanelProps): ReactElement {
  const navigate = useNavigate();
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const [interruptedDismissedFor, setInterruptedDismissedFor] = useState<string | null>(null);
  const [historyNoticeDismissedFor, setHistoryNoticeDismissedFor] = useState<string | null>(null);
  const [injectedComposerValue, setInjectedComposerValue] = useState<string | undefined>(undefined);
  const injectResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (injectResetTimerRef.current !== null) {
        clearTimeout(injectResetTimerRef.current);
      }
    },
    [],
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  /**
   * 注入 composer 值并安排下一轮复位
   *
   * 定时器统一收在 injectResetTimerRef：多次注入不堆积定时器，且卸载时清理
   * （此前两处 window.setTimeout(…, 0) 无 ref 句柄、无清理）
   */
  const injectComposerValue = (value: string): void => {
    if (injectResetTimerRef.current !== null) {
      clearTimeout(injectResetTimerRef.current);
    }
    setInjectedComposerValue(value);
    injectResetTimerRef.current = setTimeout(() => {
      injectResetTimerRef.current = null;
      setInjectedComposerValue(undefined);
    }, 0);
  };
  const { t } = useTranslation();

  const handleError = (error: Error): void => {
    useTurnErrorStore.getState().ensure(chatId, 'UNKNOWN', error.message);
  };

  const history = reconstructHistory(initialMessages ?? NO_STORED_MESSAGES);

  const { messages, sendMessage, status, stop, regenerate, setMessages } = useAgentWithIpc({
    id: chatId,
    workingDir,
    ...(history.messages.length > 0 ? { messages: history.messages } : {}),
    onError: handleError,
  });

  const earlierSeqRef = useRef(0);
  const handleLoadEarlier = (): Promise<void> => {
    if (loadEarlier === undefined) return Promise.resolve();
    return prependEarlierPage({
      loadEarlier,
      setMessages,
      toUiMessages: (messages) => {
        earlierSeqRef.current += 1;
        return toInitialMessages(messages, `earlier-${String(earlierSeqRef.current)}`);
      },
    });
  };

  const setAgentRunning = useAgentRunStore((s) => s.setRunning);
  const agentRunning = status === 'streaming' || status === 'submitted';
  useEffect(() => {
    setAgentRunning(agentRunning);
    return () => setAgentRunning(false);
  }, [agentRunning, setAgentRunning]);

  const consumePendingMessage = usePendingMessageStore((state) => state.consume);
  useEffect(() => {
    const text = consumePendingMessage(chatId);
    if (text === null) return;
    void sendMessage({ text });
  }, [chatId, sendMessage, consumePendingMessage]);

  const { currentGoal, isGoalCompleted, createGoal, clearGoal } = useChatGoals(chatId);

  const search = useConversationSearch(messages);
  const searchActiveIndex =
    search.visible && search.currentMatch >= 0
      ? (search.matchIndexes[search.currentMatch] ?? -1)
      : -1;

  const historyNotices = collectHistoryNotices(history, t);
  const showHistoryNotice = historyNotices.length > 0 && historyNoticeDismissedFor !== chatId;

  const statusText = statusLabel(status);

  const defaultProvider = useSettingsStore((state) => state.ai.defaultProvider);
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);
  const updateAi = useSettingsStore((state) => state.updateAi);
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize);

  const { compact } = useSessionCompact({ chatId, setMessages });

  useAutoCompact({
    chatId,
    messages,
    status,
    compact,
  });

  const handleRegenerate = (messageId: string): void => {
    void regenerate({ messageId });
  };

  const lastMessageId = messages.at(-1)?.id;
  const retryFailedTurn = (): void => {
    if (lastMessageId !== undefined) handleRegenerate(lastMessageId);
  };

  const { handleSend, handleSlashCommand } = createChatComposerActions({
    chatId,
    createGoal,
    injectComposerValue,
    sendMessage,
    setMessages: (msgs) => {
      setMessages(msgs as Parameters<typeof setMessages>[0]);
    },
    navigate,
    openShortcutHelp,
    setModelMenuOpen,
    compact,
    stop,
  });

  return (
    <div
      className={cn('flex h-full flex-col', className)}
      style={{ fontSize: `${editorFontSize}px` }}
    >
      <ChatStatusBar status={status} statusText={statusText} onOpenSearch={search.actions.open} />

      <InlineApprovalCard
        sessionId={chatId}
        onEditResubmit={(command) => {
          injectComposerValue(command);
        }}
      />
      <ConversationSearchBar
        visible={search.visible}
        query={search.query}
        totalMatches={search.matchIndexes.length}
        currentMatch={search.currentMatch >= 0 ? search.currentMatch + 1 : 0}
        onSearch={search.actions.search}
        onNavigate={search.actions.navigate}
        onClose={search.actions.close}
      />
      {interrupted && interruptedDismissedFor !== chatId && (
        <PanelNotice
          lines={[t('chat.runInterrupted')]}
          onDismiss={() => setInterruptedDismissedFor(chatId)}
        />
      )}
      <RateLimitBanner />

      <TurnErrorNotice
        sessionId={chatId}
        {...(lastMessageId !== undefined ? { onRetry: retryFailedTurn } : {})}
      />

      {showHistoryNotice && (
        <PanelNotice
          lines={historyNotices}
          onDismiss={() => setHistoryNoticeDismissedFor(chatId)}
        />
      )}

      <div className="min-h-0 flex-1">
        <ChatMessageList
          key={chatId}
          messages={messages}
          status={status}
          onRegenerate={handleRegenerate}
          searchActiveIndex={searchActiveIndex}
          hasEarlier={hasEarlier}
          loadingEarlier={loadingEarlier}
          {...(hasEarlier ? { onLoadEarlier: handleLoadEarlier } : {})}
        />
      </div>

      {currentGoal !== undefined && (
        <GoalBar
          goal={currentGoal}
          isCompleted={isGoalCompleted}
          onEdit={() => injectComposerValue(`/goal ${currentGoal.condition}`)}
          onClear={clearGoal}
        />
      )}
      <footer className="composer">
        <ChatInput
          status={status}
          chatId={chatId}
          workingDir={workingDir}
          {...(injectedComposerValue !== undefined ? { injectedValue: injectedComposerValue } : {})}
          onSlashCommand={handleSlashCommand}
          onSend={handleSend}
          onStop={() => {
            void stop();
          }}
          rightSlot={
            <ModelSelector
              provider={defaultProvider}
              model={defaultModel}
              onProviderChange={(p) => updateAi({ defaultProvider: p })}
              onModelChange={(m) => updateAi({ defaultModel: m })}
              open={modelMenuOpen}
              onOpenChange={setModelMenuOpen}
            />
          }
        />
      </footer>
    </div>
  );
}
