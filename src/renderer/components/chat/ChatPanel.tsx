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

import type { ChatMessage } from '@code-agent/shared/renderer';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Search, X } from 'lucide-react';
import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { InlineApprovalCard } from '@/components/agent/inline-approval-card';
import { ModelSelector } from '@/components/common/ModelSelector';
import { useAgentWithIpc } from '@/hooks/use-agent';
import { useConversationSearch } from '@/hooks/use-conversation-search';
import { SESSION_DETAIL_QUERY_KEY } from '@/hooks/use-sessions';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { unwrap, unwrapErrorMessage } from '@/lib/ipc';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { usePendingMessageStore } from '@/stores/transient/pending-message-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { ChatInput } from './ChatInput';
import { ChatMessageList } from './ChatMessageList';
import { collectHistoryNotices, statusLabel } from './chat-panel-derives';
import { ConversationSearchBar } from './conversation-search-bar';
import { GoalBar } from './GoalBar';
import { reconstructHistory, toInitialMessages } from './history-parts';
import { RateLimitBanner } from './rate-limit-banner';
import { executeSlashCommand } from './slash-commands';
import { useAutoCompact } from './use-auto-compact';
import { useChatGoals } from './use-chat-goals';

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
   * 历史消息（ChatMessage[] = ModelMessage[]，来自 session:get）
   *
   * 转换为 UIMessage 后作为 useChat 的 messages（v7 字段名）注入，
   * 打开历史会话时回显消息；仅在组件首次挂载时生效。空数组表示新会话。
   */
  initialMessages?: readonly ChatMessage[];
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
  interrupted = false,
  className,
}: ChatPanelProps): ReactElement {
  // 路由导航（斜杠命令 /new 回欢迎页）
  const navigate = useNavigate();
  // 快捷键帮助对话框（/help 斜杠命令触发）：状态收敛 ui-store，
  // 实例由 AppShell 单一 lazy 挂载（此前 ChatPanel 双份 state + 双份挂载）
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  // 中断提示条关闭状态（按 chatId 记录：切换会话后重新提示——
  // 此前单一 boolean 跨会话复用，A 会话关过一次后 B 会话的中断信号被静默抑制）
  const [interruptedDismissedFor, setInterruptedDismissedFor] = useState<string | null>(null);
  // 历史回显缺口提示的已关闭会话（按 chatId 记录：切换会话后重新提示）
  const [historyNoticeDismissedFor, setHistoryNoticeDismissedFor] = useState<string | null>(null);
  // 编辑重提注入（P2-10）：审批拒绝后把命令填入 composer（对齐参考项目）
  const [injectedComposerValue, setInjectedComposerValue] = useState<string | undefined>(undefined);
  // /models 斜杠命令：受控打开 composer 项目栏的模型选择下拉
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  // 错误码 → 本地化文案 hook
  const { getErrorMessage } = useErrorMessage();
  // 本地化文案（声明置于组件前部：派生文案在渲染前即需使用）
  const { t } = useTranslation();

  // 错误处理回调：一次性触发，避免 useEffect 双 toast
  // 策略：尝试从 error.message 提取 [CODE] 前缀匹配 i18n 文案，失败则展示原始消息
  // try/catch 双保险：getErrorMessage 异常时也绝不让 onError 抛错
  // （onError 抛错会中断 AI SDK 状态机 setStatus(error)，界面永久卡 THINKING）
  const handleError = (error: Error): void => {
    try {
      // [CODE] 前缀匹配 i18n 文案，失败回退原始消息（解析收敛至 lib/ipc 单一真源）
      toast.error(unwrapErrorMessage(error, getErrorMessage));
    } catch {
      // 极端保险：本地化失败时仍展示原始消息（onError 绝不允许抛错）
      toast.error(error.message);
    }
  };

  // 历史重建（纯函数 memo）：session:get 返回 ModelMessage 形态（role/content），
  // v7 只导出 UIMessage→ModelMessage，反向需手写；重建保留存储里真实存在的
  // tool/reasoning/file part，并如实登记无法回显的类型（见 history-parts.ts）。
  const history = useMemo(
    () => reconstructHistory(initialMessages ?? NO_STORED_MESSAGES),
    [initialMessages],
  );

  // useAgentWithIpc：Agent 模式专用 hook
  // - id: 控制消息状态隔离
  // - workingDir: agent 工具操作边界（注入 IpcAgentTransport）
  // - messages: 历史消息回显（v7 字段名，仅首次挂载生效；非空才传）
  // - onError: 统一 toast 提示（不阻塞 UI）
  // - regenerate: AI SDK v7 内置，自动截断目标 assistant 消息及后续 → 重发请求
  const { messages, sendMessage, status, stop, regenerate, setMessages } = useAgentWithIpc({
    id: chatId,
    workingDir,
    ...(history.messages.length > 0 ? { messages: history.messages } : {}),
    onError: handleError,
  });

  // 欢迎页首条消息透传：home.tsx 创建会话后 stash，本组件挂载后 consume 一次并发送。
  // useAgentWithIpc 的 transport configure effect 先于本 effect 执行（同组件内按声明
  // 顺序），发送时 transport 已就绪。consume 先删后判：StrictMode 双挂载 /
  // sendMessage 引用变化导致的重复执行均为 no-op。
  const consumePendingMessage = usePendingMessageStore((state) => state.consume);
  useEffect(() => {
    const text = consumePendingMessage(chatId);
    if (text === null) return;
    void sendMessage({ text });
  }, [chatId, sendMessage, consumePendingMessage]);

  // 会话目标（use-chat-goals.ts：goal:list/create/clear + active→completed 展示策略）
  const { currentGoal, isGoalCompleted, createGoal, clearGoal } = useChatGoals(chatId);
  // 目标预填：把文本填入输入框并聚焦（用户补需求后发送；注入后下一轮重置，允许重复触发）
  const prefillGoalInput = (text: string): void => {
    setInjectedComposerValue(text);
    window.setTimeout(() => setInjectedComposerValue(undefined), 0);
  };

  // 会话内搜索状态（对齐参考项目 useConversationSearch：受控模式）
  const search = useConversationSearch(messages);
  // 当前匹配消息索引（供 ChatMessageList 滚动 + 高亮；无匹配/关闭时为 -1）
  const searchActiveIndex =
    search.visible && search.currentMatch >= 0
      ? (search.matchIndexes[search.currentMatch] ?? -1)
      : -1;

  // 历史回显能力缺口（纯派生见 chat-panel-derives.ts：如实告知，不假装历史完整）
  const historyNotices = collectHistoryNotices(history, t);
  const showHistoryNotice = historyNotices.length > 0 && historyNoticeDismissedFor !== chatId;

  // 派生：状态指示文本（用于状态条右侧）
  const statusText = statusLabel(status);

  // 模型选择（右区插槽：输入框内发送按钮左侧，用户要求）
  const defaultProvider = useSettingsStore((state) => state.ai.defaultProvider);
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);
  const updateAi = useSettingsStore((state) => state.updateAi);
  // 编辑器设置：字体大小真实消费（消息区字号）
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize);

  // /compact 上下文压缩：主进程按模型窗口预算裁剪（compressByTokenBudget）后整体落库，
  // 渲染层同步替换本地消息态（AI SDK v7 setMessages），回合 transcript 旧消息随之清空（固有语义）
  // P2 修复：改走 useMutation 并失效会话详情缓存——此前直连 IPC 不失效，
  // staleTime 内重进会话会以压缩前旧消息重新初始化 useChat（压缩看似白做）
  const queryClient = useQueryClient();
  const compactMutation = useMutation({
    mutationFn: async () => {
      if (chatId === undefined) throw new Error(t('chat.noActiveSession'));
      return unwrap(await window.api.session.compact({ sessionId: chatId }));
    },
    onSuccess: (data) => {
      setMessages(toInitialMessages(data.messages as unknown as ChatMessage[]));
      void queryClient.invalidateQueries({ queryKey: SESSION_DETAIL_QUERY_KEY(chatId) });
      if (data.reclaimedTokens > 0) {
        toast.success(t('chat.compactDone', { tokens: data.reclaimedTokens }));
      } else {
        toast.info(t('chat.compactNothing'));
      }
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : String(error));
    },
  });

  // 长会话自动压缩（实验性 opt-in，默认关）：消息达阈值且回合空闲时自动 compact
  // （压缩会替换本地消息态，消息数骤降后不再触发；失败也不风暴——水位线机制见 hook）
  useAutoCompact({
    chatId,
    messages,
    status,
    compact: () => compactMutation.mutate(),
  });

  // 重新生成回调：透传给 ChatMessageList → MsgActions
  // useChat.regenerate({ messageId }) 会自动移除该 assistant 消息及后续所有消息，
  // 然后用截断后的 messages 重新发起请求（transport 复用同一 sessionId，AgentService 自动中断旧 stream）
  const handleRegenerate = (messageId: string): void => {
    void regenerate({ messageId });
  };

  return (
    <div
      className={cn('flex h-full flex-col', className)}
      style={{ fontSize: `${editorFontSize}px` }}
    >
      {/* 顶部状态条：等宽字体遥测带（右侧状态指示器——用户要求：左侧目录信息删掉）
          置顶（用户要求：与限流横幅互换位置） */}
      <div className="thread-status-bar">
        <div className="ml-auto inline-flex items-center gap-1.5">
          {/* 会话内搜索入口（对齐参考项目 ConversationSearchBar） */}
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground -mr-1 flex size-5 cursor-pointer items-center justify-center rounded transition-colors"
            onClick={search.actions.open}
            aria-label={t('chat.searchInConversation')}
            title={t('chat.searchInConversation')}
          >
            <Search className="size-3.5" strokeWidth={1.5} />
          </button>
          <span
            className={cn(
              'inline-flex items-center gap-1.5',
              status === 'streaming' && 'text-accent-text',
              status === 'error' && 'text-error-text',
            )}
            role="status"
            aria-label={t('chat.sessionStatus', { status: statusText })}
          >
            {/* 状态点：streaming 时脉冲动画 */}
            <span
              className={cn(
                'inline-block size-1.5 rounded-full bg-current',
                status === 'streaming' && 'animate-pulse-soft',
              )}
            />
            {statusText}
          </span>
        </div>
      </div>

      {/* 内联审批卡：当前会话 pending 审批就地呈现（对齐参考项目 InlineApprovalCard） */}
      <InlineApprovalCard
        sessionId={chatId}
        onEditResubmit={(command) => {
          // 注入后下一轮复位：相同命令二次「编辑重提」时 state 能再次变化触发注入 effect
          setInjectedComposerValue(command);
          window.setTimeout(() => setInjectedComposerValue(undefined), 0);
        }}
      />
      {/* 会话内搜索栏（受控：状态由 useConversationSearch 持有） */}
      <ConversationSearchBar
        visible={search.visible}
        query={search.query}
        totalMatches={search.matchIndexes.length}
        currentMatch={search.currentMatch >= 0 ? search.currentMatch + 1 : 0}
        onSearch={search.actions.search}
        onNavigate={search.actions.navigate}
        onClose={search.actions.close}
      />
      {/* 中断提示条：上次回合异常中断（崩溃恢复），用户可关闭 */}
      {interrupted && interruptedDismissedFor !== chatId && (
        <div className="border-[var(--amber)]/40 bg-[var(--amber)]/10 flex items-center gap-2 border-b px-3 py-1 text-xs text-warn-text">
          <AlertTriangle className="size-3 shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">{t('chat.runInterrupted')}</span>
          <button
            type="button"
            className="text-warn-text hover:text-foreground"
            aria-label={t('common.close')}
            onClick={() => setInterruptedDismissedFor(chatId ?? null)}
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      )}
      {/* 限流提示横幅：429 限流时显示（RateLimitBanner 订阅 rate-limit-store）
          位于状态条原位置（用户要求：与顶部状态条互换） */}
      <RateLimitBanner />

      {/* 历史回显缺口提示：重开会话时明确告知「哪些内容没落库/没回显」，避免用户误以为工具调用消失是渲染 bug */}
      {showHistoryNotice && (
        <div className="border-[var(--amber)]/40 bg-[var(--amber)]/10 flex items-start gap-2 border-b px-3 py-1 text-xs text-warn-text">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex flex-1 flex-col gap-0.5">
            {historyNotices.map((notice) => (
              <span key={notice} className="block">
                {notice}
              </span>
            ))}
          </span>
          <button
            type="button"
            className="text-warn-text hover:text-foreground shrink-0"
            aria-label={t('common.close')}
            onClick={() => setHistoryNoticeDismissedFor(chatId)}
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      )}

      {/* 中间消息列表 */}
      <div className="min-h-0 flex-1">
        <ChatMessageList
          // key=chatId：会话切换强制重挂载——分页窗口/底部状态不跨会话滞留
          //（此前切到大分会话时旧 windowStart 滞留，分页被旁路且落点错位）
          key={chatId}
          messages={messages}
          status={status}
          onRegenerate={handleRegenerate}
          searchActiveIndex={searchActiveIndex}
        />
      </div>

      {/* 会话目标栏（GoalBar.tsx：左 GOAL 徽标 · 中条件 · 右 编辑/删除——仅存在 active/completed 目标时显示） */}
      {currentGoal !== undefined && (
        <GoalBar
          goal={currentGoal}
          isCompleted={isGoalCompleted}
          onEdit={() => prefillGoalInput(`/goal ${currentGoal.condition}`)}
          onClear={clearGoal}
        />
      )}
      {/* 底部输入框：.composer 提供顶部渐变 + padding，内部 .composer-box 由 ChatInput 渲染 */}
      <footer className="composer">
        <ChatInput
          status={status}
          chatId={chatId}
          workingDir={workingDir}
          {...(injectedComposerValue !== undefined ? { injectedValue: injectedComposerValue } : {})}
          onSlashCommand={(action) => {
            // 斜杠命令分发（slash-commands.ts：命令 → 动作唯一映射点，纯函数可测）
            executeSlashCommand(action, {
              navigateToHome: () => navigate('/'),
              clearMessages: () => setMessages([]),
              openShortcutHelp,
              openModelMenu: () => setModelMenuOpen(true),
              compact: () => compactMutation.mutate(),
              interrupt: () => {
                void stop();
              },
              sendMessage: (text) => {
                void sendMessage({ text });
              },
              prefillGoal: () => prefillGoalInput('/goal '),
            });
          }}
          onSend={(text) => {
            // /goal 前缀：创建会话目标（用户需求：输入 /goal 需求 → 发送 → 输入框上方显示目标栏；
            // 目标命令不进对话，避免把 "/goal xxx" 当普通消息发给 AI）
            const trimmed = text.trim();
            // 精确前缀匹配：startsWith('/goal') 会把 '/goals' 等误判成目标命令
            if (trimmed === '/goal' || trimmed.startsWith('/goal ')) {
              const condition = trimmed.slice(5).trim();
              if (condition.length > 0 && chatId !== undefined) {
                createGoal(condition);
              } else {
                // /goal 无需求：重新填入输入框让用户补充需求（与斜杠建议项行为一致）
                prefillGoalInput('/goal ');
              }
              return;
            }
            // sendMessage 接受 { text: string } 格式
            void sendMessage({ text });
          }}
          onStop={() => {
            // stop 是同步操作，但返回 Promise（兼容 abortSignal）
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
