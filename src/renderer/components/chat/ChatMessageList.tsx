import type { UIMessage } from 'ai';
import { ChevronDown, Sparkles } from 'lucide-react';
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { useLatestRef } from '@/hooks/use-latest-ref';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { MessageItem } from './message-item';
import { QuestionJumpBar } from './question-jump-bar';
import { StreamingFooter } from './streaming-footer';
import { MSG_INDEX_ATTR, useMessageNavRail } from './use-message-nav-rail';

interface ChatMessageListProps {
  /** 消息列表（useChat/useAgentWithIpc 的 messages；仅含已加载的回合页） */
  readonly messages: readonly UIMessage[];
  /** 流式状态（'ready' / 'streaming' / 'submitted' / 'error'） */
  readonly status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 重新生成回调（透传给消息操作；接收消息 id） */
  readonly onRegenerate: ((messageId: string) => void) | undefined;
  /** 当前搜索匹配消息索引（滚动定位；无匹配为 -1） */
  readonly searchActiveIndex?: number;
  /** 是否仍有更早回合未加载（滚动到顶触发 onLoadEarlier） */
  readonly hasEarlier?: boolean;
  /** 更早回合加载中（顶部指示） */
  readonly loadingEarlier?: boolean;
  /** 滚动到顶回调（加载更早一页回合消息；结果由父层 prepend 进 messages） */
  readonly onLoadEarlier?: () => void;
  /** 自定义容器类名 */
  readonly className?: string;
}

/** 距底部阈值（px）：小于该值视为"在底部" */
const AT_BOTTOM_THRESHOLD = 80;

/** 距顶部阈值（px）：小于该值且仍有更早回合时触发向上补页 */
const AT_TOP_THRESHOLD = 200;

/** 消息列表 live region（2026-09-08 a11y：流式增量对读屏可见，不逐 token 刷屏） */
const MESSAGE_LIST_LIVE_PROPS = {
  'aria-live': 'polite',
  'aria-atomic': 'false',
  'aria-relevant': 'additions text',
} as const;

/**
 * 聊天消息列表组装层：消息行渲染 + 流式占位 + 滚动跟随/到底按钮 +
 * 会话内搜索定位 + 导航轨跳转；数据按回合分页，滚动到顶触发向上补页
 */
export function ChatMessageList({
  messages,
  status,
  onRegenerate,
  searchActiveIndex = -1,
  hasEarlier,
  loadingEarlier,
  onLoadEarlier,
  className,
}: ChatMessageListProps): ReactElement {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const isAtBottomRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const [hasNew, setHasNew] = useState(false);

  const isStreaming = status === 'streaming' || status === 'submitted';

  const pendingAnchorRef = useRef<number | null>(null);

  const scrollFrameRef = useRef<number | null>(null);
  const pendingHasNewRef = useRef(false);

  /** 滚动到顶判定（rAF 帧内执行）：仍有更早回合且不在加载中 → 触发补页 */
  const maybeLoadEarlier = (): void => {
    if (!hasEarlier || loadingEarlier || onLoadEarlier === undefined) {
      return;
    }
    const el = scrollerRef.current;
    if (el === null) {
      return;
    }
    pendingAnchorRef.current = el.scrollHeight;
    onLoadEarlier();
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: messages 数组身份变化即需检查补偿（流式 append 不增长高度时由 loadingEarlier 分支清位）
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current;
    if (pending === null) {
      return;
    }
    const el = scrollerRef.current;
    if (el === null) {
      pendingAnchorRef.current = null;
      return;
    }
    const delta = el.scrollHeight - pending;
    if (delta > 0) {
      el.scrollTo({ top: el.scrollTop + delta, behavior: 'instant' });
      pendingAnchorRef.current = null;
    } else if (loadingEarlier !== true) {
      pendingAnchorRef.current = null;
    }
  }, [messages, loadingEarlier]);

  const lastRole = messages.length > 0 ? messages[messages.length - 1]?.role : undefined;
  const showStreamingFooter = isStreaming && (status === 'submitted' || lastRole !== 'assistant');

  const { questions, activeTurn, scheduleSync } = useMessageNavRail({
    messages,
    scrollerRef,
  });

  /**
   * 滚动回调：底部检测 + 向上补页（rAF 合帧）
   *
   * isAtBottomRef 是最实时语义（滚动回调内同步写入，供流式自动滚动读取）；
   * UI 反映（按钮显隐、新消息红点）与补页触发统一推迟到下一帧执行一次。
   */
  const handleScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    if (atBottom) {
      pendingHasNewRef.current = false;
    }
    scheduleSync();
    scheduleScrollFrame();
  };

  /** 合帧执行滚动派生状态更新（每帧至多一次） */
  const scheduleScrollFrame = (): void => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const el = scrollerRef.current;
      if (el !== null) {
        setShowScrollBtn(
          !(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD),
        );
        setHasNew(pendingHasNewRef.current);
        if (el.scrollTop <= AT_TOP_THRESHOLD) {
          maybeLoadEarlier();
        }
      }
    });
  };

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
    },
    [],
  );

  /**
   * 滚动到底部并隐藏按钮
   */
  const scrollToBottom = (): void => {
    const el = scrollerRef.current;
    if (el !== null) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    setShowScrollBtn(false);
    setHasNew(false);
    isAtBottomRef.current = true;
  };

  /** 滚动到指定消息（导航轨/搜索定位；居中）。目标未渲染（未加载的更早回合）时静默——
   *  搜索/跳转覆盖面 = 已加载页（debt.md#d2 既有取舍） */
  const scrollToIndex = (index: number): void => {
    const el = scrollerRef.current?.querySelector(`[${MSG_INDEX_ATTR}="${index}"]`) ?? null;
    if (el !== null) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
  const scrollToIndexRef = useLatestRef(scrollToIndex);

  // biome-ignore lint/correctness/useExhaustiveDependencies: ref.current 是受控的 latest-ref 读取
  useEffect(() => {
    if (searchActiveIndex >= 0) {
      scrollToIndexRef.current(searchActiveIndex);
    }
  }, [searchActiveIndex]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意监听 messages 身份（每 chunk 变化）以驱动跟随，不读取其值
  useEffect(() => {
    if (isAtBottomRef.current) {
      const el = scrollerRef.current;
      if (el !== null) {
        if (isStreaming) {
          el.scrollTo({ top: el.scrollHeight, behavior: 'instant' });
        } else {
          el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
        }
      }
    } else {
      pendingHasNewRef.current = true;
      setHasNew(true);
    }
  }, [messages, isStreaming]);

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
    <div className={cn('relative h-full', className)}>
      <div
        ref={scrollerRef}
        data-testid="chat-message-list"
        className="messages h-full overflow-y-auto"
        onScroll={handleScroll}
        {...MESSAGE_LIST_LIVE_PROPS}
      >
        <div className="messages-inner">
          {loadingEarlier && (
            <div className="text-muted-foreground/60 py-1 text-center text-2xs">
              {t('chat.loadingEarlier')}
            </div>
          )}
          {!loadingEarlier && hasEarlier && (
            <div className="text-muted-foreground/60 py-1 text-center text-2xs">
              {t('chat.loadedMessages', { count: messages.length })}
            </div>
          )}
          {messages.map((message, index) => {
            const isStreamingMessage =
              !showStreamingFooter && isStreaming && index === messages.length - 1;
            const isContinuation =
              message.role === 'assistant' && messages[index - 1]?.role === 'assistant';
            return (
              <div
                key={message.id}
                {...{ [MSG_INDEX_ATTR]: index }}
                className={cn(
                  'transition-colors',
                  index === searchActiveIndex && 'search-highlight',
                )}
              >
                <MessageItem
                  message={message}
                  onRegenerate={onRegenerate}
                  disableActions={isStreaming}
                  {...(isStreamingMessage ? { isStreaming: true } : {})}
                  {...(isContinuation ? { isContinuation: true } : {})}
                />
              </div>
            );
          })}
          {showStreamingFooter && <StreamingFooter />}
        </div>
      </div>
      {questions.length >= 2 && (
        <QuestionJumpBar
          questions={questions}
          activeTurn={activeTurn}
          onJump={(question) => scrollToIndex(question.messageIndex)}
        />
      )}
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
