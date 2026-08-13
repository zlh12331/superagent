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
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { UIMessage } from 'ai';
import { AlertTriangle, Folder, Pause, Pencil, Play, Search, Trash2, X } from 'lucide-react';
import { type ReactElement, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';

import { InlineApprovalCard } from '@/components/agent/inline-approval-card';
import { ModelSelector } from '@/components/common/ModelSelector';
import { ShortcutHelpDialog } from '@/components/common/ShortcutHelpDialog';
import { useAgentWithIpc } from '@/hooks/use-agent';
import { useConversationSearch } from '@/hooks/use-conversation-search';
import { useErrorMessage, useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { EMPTY_USAGE, useUsageStore } from '@/stores/transient/usage-store';
import { ChatInput } from './ChatInput';
import { ChatMessageList } from './ChatMessageList';
import { ConversationSearchBar } from './conversation-search-bar';
import { RateLimitBanner } from './rate-limit-banner';

/**
 * ModelMessage → UIMessage（历史消息回显用）
 *
 * AI SDK v7 的 useChat messages 字段需要 UIMessage 格式（id/role/parts），
 * 但 session:get 返回的是 ModelMessage 格式（role/content，与 SQLite 存储一致）；
 * v7 只导出 UIMessage→ModelMessage 的 convertToModelMessages，反向需手写。
 * 仅提取文本内容（tool/reasoning 等复杂 part 不参与回显）。
 */
function toInitialMessages(messages: readonly ChatMessage[]): UIMessage[] {
  return messages.map((m, index) => {
    const role: UIMessage['role'] =
      m.role === 'assistant' ? 'assistant' : m.role === 'system' ? 'system' : 'user';
    const content = m.content;
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter(
                (p): p is { type: 'text'; text: string } =>
                  typeof p === 'object' &&
                  p !== null &&
                  'type' in p &&
                  p.type === 'text' &&
                  typeof (p as { text?: unknown }).text === 'string',
              )
              .map((p) => p.text)
              .join('\n')
          : '';
    return {
      id: `hist-${index}`,
      role,
      parts: [{ type: 'text', text }],
    };
  });
}

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
  // 快捷键帮助对话框（/help 斜杠命令触发；对齐参考项目：命令即时执行而非 toast）
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  // 中断提示条关闭状态（会话内关闭后不再显示）
  const [interruptedDismissed, setInterruptedDismissed] = useState(false);
  // 编辑重提注入（P2-10）：审批拒绝后把命令填入 composer（对齐参考项目）
  const [injectedComposerValue, setInjectedComposerValue] = useState<string | undefined>(undefined);
  // 错误码 → 本地化文案 hook
  const { getErrorMessage } = useErrorMessage();

  // 错误处理回调：一次性触发，避免 useEffect 双 toast
  // 策略：尝试从 error.message 提取 [CODE] 前缀匹配 i18n 文案，失败则展示原始消息
  // try/catch 双保险：getErrorMessage 异常时也绝不让 onError 抛错
  // （onError 抛错会中断 AI SDK 状态机 setStatus(error)，界面永久卡 THINKING）
  const handleError = (error: Error): void => {
    try {
      // 尝试从 error.message 提取错误码（格式 "[CODE] message"）
      const codeMatch = /^\[([A-Z_]+)\]/.exec(error.message);
      if (codeMatch !== null) {
        const code = codeMatch[1] as Parameters<typeof getErrorMessage>[0];
        toast.error(getErrorMessage(code));
      } else {
        // 兜底：直接展示原始 error.message
        toast.error(error.message);
      }
    } catch {
      // 极端保险：本地化失败时仍展示原始消息（onError 绝不允许抛错）
      toast.error(error.message);
    }
  };

  // useAgentWithIpc：Agent 模式专用 hook
  // - id: 控制消息状态隔离
  // - workingDir: agent 工具操作边界（注入 IpcAgentTransport）
  // - messages: 历史消息回显（v7 字段名，仅首次挂载生效；非空才传）
  // - onError: 统一 toast 提示（不阻塞 UI）
  // - regenerate: AI SDK v7 内置，自动截断目标 assistant 消息及后续 → 重发请求
  const { messages, sendMessage, status, stop, regenerate, setMessages } = useAgentWithIpc({
    id: chatId,
    workingDir,
    ...(initialMessages !== undefined && initialMessages.length > 0
      ? { messages: toInitialMessages(initialMessages) }
      : {}),
    onError: handleError,
  });

  // 会话目标（用户要求：仅 goal 命令设置后显示，置于对话区输入框上方）
  const goalsQuery = useQuery({
    queryKey: ['goal', 'list', chatId],
    enabled: chatId !== undefined,
    queryFn: async () => {
      if (chatId === undefined) return { goals: [] as unknown[] };
      const response = await window.api.goal.list({ sessionId: chatId });
      if ('error' in response && response.error !== undefined) {
        return { goals: [] as unknown[] };
      }
      if ('data' in response && response.data !== undefined) {
        return response.data;
      }
      return { goals: [] as unknown[] };
    },
  });
  const goals = (goalsQuery.data?.goals ?? []) as Array<{ condition: string }>;
  const queryClient = useQueryClient();
  // 暂停状态（用户设计：右按钮区 暂停/恢复 · 编辑 · 删除）
  const [goalPaused, setGoalPaused] = useState(false);
  // chatId 切换：重置目标栏 UI 状态（暂停不跨会话残留）
  // biome-ignore lint/correctness/useExhaustiveDependencies: chatId 是故意的触发键（effect 仅用 setter）
  useEffect(() => {
    setGoalPaused(false);
  }, [chatId]);
  // 目标预填：把文本填入输入框并聚焦（用户补需求后发送；注入后下一轮重置，允许重复触发）
  const prefillGoalInput = (text: string): void => {
    setInjectedComposerValue(text);
    window.setTimeout(() => setInjectedComposerValue(undefined), 0);
  };
  const createGoalMutation = useMutation({
    mutationFn: async (condition: string) => {
      if (chatId === undefined) return;
      const response = await window.api.goal.create({ sessionId: chatId, condition });
      if ('error' in response && response.error !== undefined) {
        throw new Error(response.error.message);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goal', 'list', chatId] });
    },
  });
  const clearGoalMutation = useMutation({
    mutationFn: async () => {
      if (chatId === undefined) return;
      const response = await window.api.goal.clear({ sessionId: chatId });
      if ('error' in response && response.error !== undefined) {
        throw new Error(response.error.message);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['goal', 'list', chatId] });
    },
  });

  // 会话内搜索状态（对齐参考项目 useConversationSearch：受控模式）
  const search = useConversationSearch(messages);
  // 当前匹配消息索引（供 ChatMessageList 滚动 + 高亮；无匹配/关闭时为 -1）
  const searchActiveIndex =
    search.visible && search.currentMatch >= 0
      ? (search.matchIndexes[search.currentMatch] ?? -1)
      : -1;

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

  // 模型选择（对齐原型 composer-project-bar .model-select：输入栏底部条）
  const defaultProvider = useSettingsStore((state) => state.ai.defaultProvider);
  const defaultModel = useSettingsStore((state) => state.ai.defaultModel);
  const updateAi = useSettingsStore((state) => state.updateAi);

  // 派生：当前会话累积 token 用量（per-session，回合结束后由 usage-store 累积）
  const usage = useUsageStore((s) => s.usageBySession.get(chatId) ?? EMPTY_USAGE);
  const usageText =
    usage.totalTokens > 0
      ? `${usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : usage.totalTokens} tok`
      : null;
  // 本地化文案
  const { t } = useTranslation();
  // 编辑器设置：字体大小真实消费（消息区字号）
  const editorFontSize = useSettingsStore((s) => s.editor.fontSize);

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
      {/* 限流提示横幅：429 限流时显示（RateLimitBanner 订阅 rate-limit-store） */}
      <RateLimitBanner />
      {/* 内联审批卡：当前会话 pending 审批就地呈现（对齐参考项目 InlineApprovalCard） */}
      <InlineApprovalCard
        sessionId={chatId}
        onEditResubmit={(command) => setInjectedComposerValue(command)}
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
      {interrupted && !interruptedDismissed && (
        <div className="border-[var(--amber)]/40 bg-[var(--amber)]/10 flex items-center gap-2 border-b px-3 py-1 text-xs text-[var(--warn)]">
          <AlertTriangle className="size-3 shrink-0" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate">{t('chat.runInterrupted')}</span>
          <button
            type="button"
            className="text-[var(--warn)] hover:text-[var(--amber-dim)]"
            aria-label={t('common.close')}
            onClick={() => setInterruptedDismissed(true)}
          >
            <X className="size-3.5" strokeWidth={2} />
          </button>
        </div>
      )}
      {/* 顶部状态条：等宽字体遥测带（右侧状态指示器——用户要求：左侧目录信息删掉） */}
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
              status === 'streaming' && 'text-[var(--aurora-accent)]',
              status === 'error' && 'text-destructive',
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
        {/* token 用量（回合结束后显示，悬浮提示明细） */}
        {usageText !== null && (
          <span
            className="text-muted-foreground/60 font-mono text-2xs"
            title={t('chat.tokenUsage', {
              input: usage.inputTokens,
              output: usage.outputTokens,
              total: usage.totalTokens,
            })}
          >
            {usageText}
          </span>
        )}
      </div>

      {/* 中间消息列表 */}
      <div className="min-h-0 flex-1">
        <ChatMessageList
          messages={messages}
          status={status}
          onRegenerate={handleRegenerate}
          searchActiveIndex={searchActiveIndex}
        />
      </div>

      {/* 会话目标栏（用户设计：左 GOAL 标签 · 中条件 · 右 暂停/恢复 · 编辑 · 删除——仅 goal 命令设置后显示） */}
      {goals.length > 0 && (
        <div className="border-border bg-muted/30 mx-auto mb-1 flex w-full max-w-2xl items-center gap-2 rounded-md border px-3 py-1.5">
          <span className="bg-accent/10 text-accent rounded px-1.5 py-0.5 font-mono text-[10px] font-bold">
            GOAL
          </span>
          <span
            className={cn(
              'text-foreground/90 min-w-0 flex-1 truncate text-xs',
              goalPaused && 'text-muted-foreground/60 line-through',
            )}
            title={goals[0]?.condition}
          >
            {goals[0]?.condition}
          </span>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
              title={goalPaused ? t('chat.goalResume') : t('chat.goalPause')}
              aria-label={goalPaused ? t('chat.goalResume') : t('chat.goalPause')}
              onClick={() => setGoalPaused((p) => !p)}
            >
              {goalPaused ? <Play className="size-3" /> : <Pause className="size-3" />}
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
              title={t('chat.goalEdit')}
              aria-label={t('chat.goalEdit')}
              onClick={() => prefillGoalInput(`/goal ${goals[0]?.condition ?? ''}`)}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive flex size-6 cursor-pointer items-center justify-center rounded transition-colors"
              title={t('chat.goalClear')}
              aria-label={t('chat.goalClear')}
              onClick={() => clearGoalMutation.mutate()}
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        </div>
      )}
      {/* 底部输入框：.composer 提供顶部渐变 + padding，内部 .composer-box 由 ChatInput 渲染 */}
      <footer className="composer">
        <ChatInput
          status={status}
          chatId={chatId}
          workingDir={workingDir}
          {...(injectedComposerValue !== undefined ? { injectedValue: injectedComposerValue } : {})}
          onSlashCommand={(action) => {
            // 斜杠命令执行（对齐参考项目）：/new 回欢迎页新建，/clear 清空对话，/help 打开快捷键帮助
            switch (action) {
              case 'new':
                navigate('/');
                break;
              case 'clear':
                // 清空对话（AI SDK v7 无 clearMessages，用 setMessages([])）
                setMessages([]);
                break;
              case 'help':
                // 即时打开快捷键帮助对话框（照搬参考项目 /help 行为）
                setShortcutHelpOpen(true);
                break;
              case 'models':
              case 'compact':
                // 模型选择/压缩：toast 引导（完整链路后续增强）
                toast.info(t(`chat.slashAction.${action}`));
                break;
              case 'interrupt':
                // /interrupt 即时中断（对齐参考项目：停止当前生成）
                void stop();
                break;
              case 'goal':
                // /goal 斜杠建议：填入输入框（用户需求：唯一交互 = 输入 /goal 需求直接发送；
                // 点建议后输入框预填 "/goal "，用户补需求回车即创建目标）
                prefillGoalInput('/goal ');
                break;
            }
          }}
          onSend={(text) => {
            // /goal 前缀：创建会话目标（用户需求：输入 /goal 需求 → 发送 → 输入框上方显示目标栏；
            // 目标命令不进对话，避免把 "/goal xxx" 当普通消息发给 AI）
            const trimmed = text.trim();
            if (trimmed.startsWith('/goal')) {
              const condition = trimmed.slice(5).trim();
              if (condition.length > 0 && chatId !== undefined) {
                createGoalMutation.mutate(condition);
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
        />
        {/* composer-project-bar：项目 + 模型选择（对齐原型；对话模式项目只读展示当前工作目录） */}
        <div className="composer-project-bar">
          <div className="cpb-folder-group">
            <span className="cpb-select" title={workingDir}>
              <Folder className="size-3" strokeWidth={1.5} />
              <span className="max-w-40 truncate">{workingDirBasename}</span>
            </span>
          </div>
          <ModelSelector
            provider={defaultProvider}
            model={defaultModel}
            onProviderChange={(p) => updateAi({ defaultProvider: p })}
            onModelChange={(m) => updateAi({ defaultModel: m })}
          />
        </div>
      </footer>
      {/* 快捷键帮助对话框（/help 触发） */}
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />
    </div>
  );
}
