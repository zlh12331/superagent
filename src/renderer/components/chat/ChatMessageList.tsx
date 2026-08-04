// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · Aurora 设计系统
// ──────────────────────────────────────────────────────────────
// 职责：
// - 渲染 UIMessage 数组（user / assistant / system 三种角色）
// - assistant 消息按 parts 分发渲染（text / reasoning / tool / file / step-start 等）
// - 智能自动滚动：仅当用户在底部附近时跟随，否则显示 scroll-to-bottom 按钮
// - 空状态展示 EmptyState 组件
//
// 设计（对齐原型 docs/prototype/prototype-v2.html）：
// - user 消息：.msg.user > .msg-body > .msg-content（玻璃渐变气泡，靠右由 .msg-content 自身样式实现）
// - assistant 消息：.msg.assistant > .msg-avatar.assistant + .msg-body > .msg-role + .msg-content（无气泡开放排版）
// - tool 调用：.msg.msg-tool > .msg-body > .card.tool-card（可折叠卡片）
// - reasoning：.reasoning-block（折叠式推理块，accent 左光条）
// - system 消息：居中小字
// - streaming 占位：typing-indicator（三个 accent 点弹跳）
// - 滚动到底部按钮：.scroll-to-bottom（距底部 > 80px 时显示，有新消息加 .has-new）
// ──────────────────────────────────────────────────────────────
//
// 说明：
// - 不在此组件内调用 useChat，messages / status 由父组件传入
// - 仅做展示，不做任何业务逻辑
// - 使用 AI SDK 官方类型守卫（isTextUIPart / isReasoningUIPart 等）
// - part 类型用 UIMessage['parts'][number] 派生，避免手写泛型参数

// type-only import：仅引入类型，不引入运行时依赖
import type { UIMessage } from 'ai';
// AI SDK 官方类型守卫：在运行时判断 part 类型并收窄 TypeScript 类型
import {
  isDynamicToolUIPart,
  isFileUIPart,
  isReasoningUIPart,
  isStaticToolUIPart,
  isTextUIPart,
} from 'ai';
import type { TFunction } from 'i18next';
import { ChevronDown, Copy, RefreshCw, Sparkles } from 'lucide-react';
import { motion } from 'motion/react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { EmptyState } from '@/components/common/EmptyState';
import { useTranslation } from '@/i18n/use-translation';
import { smoothEaseOut } from '@/lib/motion';
import { cn } from '@/lib/utils';
import { useToolStore } from '@/stores/transient/tool-store';

import { Markdown } from './Markdown';

/**
 * UIMessage parts 元素类型
 *
 * 从 UIMessage 默认参数化派生，避免手写 `UIMessagePart<UIDataTypes, UITools>`
 * （UIDataTypes / UITools 是 AI SDK 内部类型，外部不应直接引用）。
 */
type UIMessagePart = UIMessage['parts'][number];

interface ChatMessageListProps {
  /** 消息数组（来自 useChat().messages） */
  messages: readonly UIMessage[];
  /** 当前流式状态（'streaming' / 'submitted' 时显示流式占位） */
  status: 'submitted' | 'streaming' | 'ready' | 'error';
  /**
   * 重新生成指定 assistant 消息（对齐原型 .msg-actions 重新生成按钮）
   *
   * 由 ChatPanel 传入，内部调用 useChat.regenerate({ messageId })。
   * 流式状态（streaming/submitted）下按钮自动禁用，避免并发请求。
   */
  onRegenerate?: (messageId: string) => void;
  /** 自定义容器类名 */
  className?: string;
}

/**
 * 聊天消息列表（react-virtuoso 虚拟化）
 *
 * 渲染规则（对齐 Aurora 原型）：
 * - user 消息：.msg.user > .msg-body > .msg-content（玻璃渐变气泡）
 * - assistant 消息：.msg.assistant > .msg-avatar.assistant + .msg-body > .msg-role + .msg-content
 * - tool 调用：.msg.msg-tool > .msg-body > .card.tool-card（可折叠卡片）
 * - system 消息：居中淡灰小字
 *
 * 虚拟化（react-virtuoso）：
 * - 仅渲染可视区消息，长对话不卡顿（替代手写 .messages-inner 全量渲染）
 * - followOutput：流式时用户位于底部则平滑跟随，否则不抢滚动
 * - atBottomStateChange：底部检测驱动 scroll-to-bottom 按钮与 hasNew 红点
 *
 * @example
 * ```tsx
 * <ChatMessageList messages={messages} status={status} />
 * ```
 */
export function ChatMessageList({
  messages,
  status,
  onRegenerate,
  className,
}: ChatMessageListProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // Virtuoso 句柄：用于 scrollToIndex 滚动到底部
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // 是否在底部附近（ref 版本：在回调中写入，避免闭包陷阱）
  const isAtBottomRef = useRef(true);

  // 是否显示"滚动到底部"按钮（距底部 > 阈值时显示）
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 是否有新消息到达且用户不在底部（按钮显示 .has-new 红点）
  const [hasNew, setHasNew] = useState(false);

  // 流式状态（streaming / submitted）时显示占位"..."
  const isStreaming = status === 'streaming' || status === 'submitted';

  /**
   * Virtuoso 内置底部检测回调（替换手写 scroll 监听）
   *
   * - 在底部附近：隐藏按钮，清除 hasNew
   * - 不在底部：显示按钮
   */
  const handleAtBottomChange = (atBottom: boolean): void => {
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      setShowScrollBtn(false);
      setHasNew(false);
    } else {
      setShowScrollBtn(true);
    }
  };

  /**
   * 滚动到底部并隐藏按钮
   */
  const scrollToBottom = (): void => {
    virtuosoRef.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'smooth' });
    setShowScrollBtn(false);
    setHasNew(false);
    isAtBottomRef.current = true;
  };

  // 智能自动滚动：messages 长度变化或流式状态变化时触发
  // - 用户在底部附近：Virtuoso followOutput 自动跟随（无需手动滚动）
  // - 用户不在底部：标记 hasNew（按钮显示新消息红点）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意监听 messages.length 与 isStreaming，触发标记而不读取其值
  useEffect(() => {
    if (!isAtBottomRef.current) {
      setHasNew(true);
    }
  }, [messages.length, isStreaming]);

  // 空状态：无消息时展示 EmptyState
  if (messages.length === 0) {
    return (
      <div className={cn('flex h-full items-center justify-center', className)}>
        <EmptyState
          icon={<Sparkles className="size-6" strokeWidth={1.5} />}
          title={t('chat.startNewChat')}
          description={t('chat.startNewChatDesc')}
        />
      </div>
    );
  }

  return (
    // 外层 wrapper：position: relative 让 .scroll-to-bottom（absolute）正确定位
    <div className={cn('relative h-full', className)}>
      <Virtuoso
        ref={virtuosoRef}
        className="messages h-full"
        data={messages}
        // 流式跟随：用户在底部时平滑跟随新内容，否则不抢滚动（hasNew 由 effect 标记）
        followOutput={(atBottom) => (atBottom ? 'smooth' : false)}
        atBottomStateChange={handleAtBottomChange}
        itemContent={(_, message) => (
          <MessageItem message={message} onRegenerate={onRegenerate} disableActions={isStreaming} />
        )}
        // 流式占位：assistant 正在响应时渲染在列表尾部（Footer 插槽）
        // biome-ignore lint/style/useNamingConvention: Virtuoso Components 接口的 Footer 字段为 PascalCase
        {...(isStreaming ? { components: { Footer: StreamingFooter } } : {})}
      />
      {/* 滚动到底部按钮（对齐原型 .scroll-to-bottom，作为 .messages 的兄弟元素） */}
      <button
        type="button"
        className={cn('scroll-to-bottom', showScrollBtn && 'visible', hasNew && 'has-new')}
        onClick={scrollToBottom}
        aria-label={t('chat.scrollToBottom')}
        title={t('chat.scrollToBottom')}
      >
        <ChevronDown className="size-4" strokeWidth={2.5} />
        <span className="new-msg-dot" aria-hidden="true" />
      </button>
    </div>
  );
}

/** Virtuoso Footer 插槽：流式占位（assistant 正在响应时显示 typing-indicator） */
function StreamingFooter(): ReactElement {
  return <StreamingPlaceholder />;
}

// ──────────────────────────────────────────────────────────────
// 内部组件
// ──────────────────────────────────────────────────────────────

/**
 * 单条消息渲染
 *
 * 按 message.role 分发到不同的展示样式：
 * - 'user'：.msg.user > .msg-body > .msg-content（玻璃渐变气泡）
 * - 'assistant'：.msg.assistant > .msg-avatar.assistant + .msg-body > .msg-role + parts
 * - 'system'：居中淡灰小字
 */
function MessageItem({
  message,
  onRegenerate,
  disableActions,
}: {
  message: UIMessage;
  onRegenerate: ((messageId: string) => void) | undefined;
  disableActions: boolean;
}): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  if (message.role === 'user') {
    // user 消息：仅 .msg-body > .msg-content，气泡样式由 .msg-content 提供（玻璃渐变）
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg user enter-anim"
      >
        <div className="msg-body">
          <div className="msg-content">
            {/* user 消息仅渲染 text parts（拼接为单一字符串，保留换行） */}
            {extractText(message.parts)}
          </div>
        </div>
      </motion.div>
    );
  }

  if (message.role === 'assistant') {
    // assistant 消息：avatar + body（role + parts + actions）
    // 对齐原型 addMsgActions()：仅 assistant 消息显示 hover 操作栏
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={smoothEaseOut}
        className="msg assistant enter-anim"
      >
        <div className="msg-avatar assistant" aria-hidden="true">
          C
        </div>
        <div className="msg-body">
          <div className="msg-role assistant">{t('chat.assistant')}</div>
          {/* parts 列表：按 part 类型分别渲染 */}
          {message.parts.map((part, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: parts 是 append-only 序列，index 在单条消息内唯一稳定
            <PartView key={`${message.id}-${index}`} part={part} />
          ))}
          {/* hover 操作栏：复制 + 重新生成（对齐原型 .msg-actions） */}
          <MsgActions
            text={extractText(message.parts)}
            messageId={message.id}
            onRegenerate={onRegenerate}
            disabled={disableActions}
          />
        </div>
      </motion.div>
    );
  }

  // system 消息：居中淡灰小字
  return (
    <div className="flex justify-center">
      <div className="text-muted-foreground font-mono text-xs italic">
        {extractText(message.parts)}
      </div>
    </div>
  );
}

/**
 * 单个 part 渲染
 *
 * 根据 part.type 分发到不同的展示组件：
 * - 'text'：.msg-content > Markdown（GFM 解析 + shiki 代码高亮）
 * - 'reasoning'：.reasoning-block（折叠式推理块，accent 左光条）
 * - 'tool-*' / 'dynamic-tool'：.card.tool-card（可折叠工具卡片）
 * - 'file'：.card 简易附件卡片
 * - 'step-start'：细分隔线表示新步骤
 * - 其他：fallback 展示 part.type
 */
function PartView({ part }: { part: UIMessagePart }): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 文本 part：Markdown 渲染（支持 GFM + 代码语法高亮）
  if (isTextUIPart(part)) {
    if (part.text.length === 0) {
      return <div className="msg-content" />;
    }
    return (
      <div className="msg-content">
        <Markdown content={part.text} />
      </div>
    );
  }

  // 思考 part：.reasoning-block 折叠式推理块
  if (isReasoningUIPart(part)) {
    return <ReasoningBlock text={part.text} />;
  }

  // 静态工具调用（tool-{name}）
  // 注意：errorText 在不同 state 下可能为 string 或 undefined，
  // 用 ?? undefined 统一为 string | undefined（兼容 exactOptionalPropertyTypes）
  if (isStaticToolUIPart(part)) {
    return (
      <ToolCallView
        type={part.type}
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 动态工具调用（dynamic-tool）
  if (isDynamicToolUIPart(part)) {
    return (
      <ToolCallView
        type={`dynamic-tool: ${part.toolName}`}
        toolCallId={part.toolCallId}
        state={part.state}
        input={part.input}
        output={part.output}
        errorText={part.errorText ?? undefined}
      />
    );
  }

  // 文件 part：展示为 .card 简易附件卡片
  if (isFileUIPart(part)) {
    return (
      <div className="card">
        <div className="card-head">
          <span className="card-icon">📎</span>
          <span className="card-title">{t('chat.attachment')}</span>
          <span className="card-status pending">{part.mediaType}</span>
        </div>
      </div>
    );
  }

  // step-start：步骤分隔线
  if (part.type === 'step-start') {
    return (
      <div className="border-border my-2 flex items-center gap-2 border-t pt-1">
        <span className="text-muted-foreground font-mono text-xs italic">{t('chat.nextStep')}</span>
      </div>
    );
  }

  // fallback：未知 part 类型，展示 type 字符串
  return (
    <div className="text-muted-foreground font-mono text-xs italic">
      {t('chat.unknownPart', { type: part.type })}
    </div>
  );
}

/**
 * 工具调用卡片（对齐原型 .card.tool-card）
 *
 * 显示工具名称、状态、入参、输出 / 错误。
 * 可折叠：点击 card-head 切换 .open 类。
 *
 * 注意：可选字段使用 `T | undefined` 而非 `T?`，
 * 以兼容 exactOptionalPropertyTypes（exactOptionalPropertyTypes 下 `T?` 不允许显式传入 undefined）。
 */
interface ToolCallViewProps {
  type: string;
  toolCallId: string;
  state: string;
  input: unknown | undefined;
  output: unknown | undefined;
  errorText: string | undefined;
}

function ToolCallView({
  type,
  toolCallId,
  state,
  input,
  output,
  errorText,
}: ToolCallViewProps): ReactElement {
  // 折叠状态：默认折叠（对齐原型 #toolCard 初始无 .open 类）
  const [open, setOpen] = useState(false);
  // 本地化文案
  const { t } = useTranslation();

  // 从 tool-store 查找 title（主进程通过 AgentToolResultPayload 推送的人类可读标题）
  // 没有找到时回退到工具名（type）
  const title = useToolStore((s) => {
    for (const calls of s.callsBySession.values()) {
      const found = calls.find((c) => c.id === toolCallId);
      if (found !== undefined) return found.title;
    }
    return null;
  });

  // 状态映射：AI SDK state → .card-status 类 + 本地化文案
  const statusClass = mapToolStateToStatusClass(state);
  const statusLabel = mapToolStateToStatusLabelKey(state);
  const localizedStatusLabel = t(`chat.${statusLabel}`);

  return (
    <div className="msg msg-tool enter-anim">
      <div className="msg-body">
        <div className={cn('card tool-card', open && 'open')}>
          <button
            type="button"
            className="card-head"
            onClick={() => setOpen((v) => !v)}
            aria-label={t('chat.toggleToolDetails')}
            aria-expanded={open}
          >
            <span className="card-icon">🔧</span>
            <span className="card-title">{title ?? type}</span>
            <span className={cn('card-status', statusClass)}>{localizedStatusLabel}</span>
            <span className="tool-chev">▸</span>
          </button>
          <div className="card-body">
            {/* 入参（JSON 序列化，最多 200 字符避免膨胀） */}
            {input !== undefined && <CodeBlock label="input" content={formatJson(input, t)} />}
            {/* 输出（output 优先于 errorText） */}
            {output !== undefined && <CodeBlock label="output" content={formatJson(output, t)} />}
            {errorText !== undefined && errorText !== '' && (
              <CodeBlock label="error" content={errorText} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 工具状态映射 → 本地化 key（组件内 t(`chat.${key}`) 渲染）
 *
 * AI SDK 的 tool.state 可能值：
 * - 'input-streaming' / 'input-accepted'：输入阶段（等待）
 * - 'output-available'：完成（成功）
 * - 'output-error'：错误（error）
 */
function mapToolStateToStatusLabelKey(state: string): string {
  if (state === 'output-error') {
    return 'statusError';
  }
  if (state === 'output-available') {
    return 'statusSuccess';
  }
  if (state === 'input-streaming' || state === 'input-accepted') {
    return 'statusRunning';
  }
  return 'statusWaiting';
}

/**
 * 工具状态映射 → .card-status 类名
 *
 * AI SDK 的 tool.state 可能值：
 * - 'input-streaming' / 'input-accepted'：输入阶段（pending）
 * - 'output-available'：完成（success）
 * - 'output-error'：错误（error）
 */
function mapToolStateToStatusClass(state: string): string {
  if (state === 'output-error') {
    return 'error';
  }
  if (state === 'output-available') {
    return 'success';
  }
  if (state === 'input-streaming' || state === 'input-accepted') {
    return 'running';
  }
  return 'pending';
}

/**
 * 代码块（带标签 + 内容）
 *
 * 用于展示工具调用的 input / output / error。
 */
function CodeBlock({ label, content }: { label: string; content: string }): ReactElement {
  return (
    <div className="mt-1">
      <div className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider">
        {label}
      </div>
      <pre className="bg-background/50 text-foreground mt-0.5 overflow-x-auto rounded p-1.5 font-mono text-[11px] leading-snug">
        {content}
      </pre>
    </div>
  );
}

/**
 * 推理块（对齐原型 .reasoning-block）
 *
 * 折叠式：默认折叠，点击 head 切换 .open 类。
 * accent 左光条 + 等宽字体展示思考内容。
 */
function ReasoningBlock({ text }: { text: string }): ReactElement {
  const [open, setOpen] = useState(false);
  // 本地化文案
  const { t } = useTranslation();

  return (
    <div className={cn('reasoning-block', open && 'open')}>
      <button
        type="button"
        className="reasoning-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="reasoning-title">{t('chat.thinking')}</span>
        <span className="rh-chevron" style={{ marginLeft: 'auto' }}>
          ▸
        </span>
      </button>
      <div className="reasoning-body">
        <div className="text-muted-foreground font-mono text-xs leading-relaxed whitespace-pre-wrap italic">
          {text}
        </div>
      </div>
    </div>
  );
}

/**
 * 流式占位
 *
 * streaming 状态时显示在消息列表末尾的 typing-indicator（三个 accent 点弹跳），
 * 表示助手正在生成回复。对齐原型 .msg.assistant + .typing-indicator 结构。
 */
function StreamingPlaceholder(): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  return (
    <div className="msg assistant enter-anim">
      <div className="msg-avatar assistant" aria-hidden="true">
        C
      </div>
      <div className="msg-body">
        <div className="msg-role assistant">{t('chat.assistant')}</div>
        <div className="typing-indicator" role="status" aria-label={t('chat.assistantTyping')}>
          <span className="ti-dot" />
          <span className="ti-dot" />
          <span className="ti-dot" />
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 消息微交互组件
// ──────────────────────────────────────────────────────────────

/**
 * 消息 hover 操作栏（对齐原型 addMsgActions + .msg-actions）
 *
 * - 默认 opacity:0，hover .msg 时 opacity:1（CSS 控制）
 * - 复制：navigator.clipboard 写入纯文本，2s 内显示 copied 反馈
 * - 重新生成：调用 useChat.regenerate({ messageId })，流式状态下禁用避免并发
 *
 * 仅在 assistant 消息渲染（跳过 tool 消息），对齐原型 addMsgActions 逻辑。
 */
function MsgActions({
  text,
  messageId,
  onRegenerate,
  disabled,
}: {
  text: string;
  messageId: string;
  onRegenerate: ((messageId: string) => void) | undefined;
  disabled: boolean;
}): ReactElement {
  const [copied, setCopied] = useState(false);
  // 本地化文案
  const { t } = useTranslation();
  // copy 按钮 2s 复位定时器：组件卸载时清理，避免 setState on unmounted component 内存泄漏
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
    },
    [],
  );

  const handleCopy = async (): Promise<void> => {
    if (text.length === 0) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (copyTimerRef.current !== null) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 2000);
    } catch {
      // clipboard 不可用时静默失败
    }
  };

  const handleRegenerate = (): void => {
    if (disabled) return;
    onRegenerate?.(messageId);
  };

  return (
    <div className="msg-actions show">
      <button
        type="button"
        className={cn('msg-action-btn', copied && 'copied')}
        onClick={handleCopy}
        aria-label={copied ? t('chat.copied') : t('chat.copy')}
        title={copied ? t('chat.copied') : t('chat.copy')}
      >
        <Copy />
        {copied ? t('chat.copied') : t('chat.copy')}
      </button>
      <button
        type="button"
        className="msg-action-btn"
        aria-label={t('chat.regenerate')}
        title={disabled ? t('chat.generating') : t('chat.regenerate')}
        onClick={handleRegenerate}
        disabled={disabled}
      >
        <RefreshCw />
        {t('chat.regenerate')}
      </button>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────
// 工具函数
// ──────────────────────────────────────────────────────────────

/**
 * 从 parts 中提取所有文本并拼接
 *
 * 用于 user / system 消息（只展示文本内容）。
 */
function extractText(parts: readonly UIMessagePart[]): string {
  return parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join('\n');
}

/**
 * JSON 序列化（截断到 200 字符，避免大对象撑爆 UI）
 */
function formatJson(value: unknown, t: TFunction): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? 'undefined';
    return json.length > 200 ? `${json.slice(0, 200)}\n…${t('chat.truncatedJson')}` : json;
  } catch {
    return String(value);
  }
}
