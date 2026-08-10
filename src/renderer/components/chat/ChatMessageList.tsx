// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · 组装层（消息行/流式尾部/操作按钮提取至独立文件）
// ──────────────────────────────────────────────
// 拆分背景（2026-08 重构）：原文件 685 行混合渲染/操作/纯函数，按职责拆分：
// - message-item.tsx：消息行渲染（PartView/工具调用/代码块/推理块）
// - streaming-footer.tsx：流式尾部（生成中/占位）
// - message-actions.tsx：消息操作（复制/重试/重新生成）
// ──────────────────────────────────────────────
// 渲染策略（2026-08 调整）：普通滚动渲染（去 Virtuoso）——
// react-virtuoso 在 React 19 下存在 data 空→非空更新时序 bug（发送消息后
// 列表不渲染新消息，CDP 实测定位），消息渲染正确性优先；流式场景下
// MessageItem 内部按消息 id 记忆化，仅变化消息重渲染，性能可接受。
// ──────────────────────────────────────────────

import type { UIMessage } from 'ai';
import { ChevronDown, Sparkles } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { MessageItem } from './message-item';
import { StreamingFooter } from './streaming-footer';

/** 消息导航轨元素的数据属性（滚动定位用） */
const MSG_INDEX_ATTR = 'data-msg-index';

interface ChatMessageListProps {
  /** 消息列表（useChat/useAgentWithIpc 的 messages） */
  readonly messages: readonly UIMessage[];
  /** 流式状态（'ready' / 'streaming' / 'submitted' / 'error'） */
  readonly status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 重新生成回调（透传给消息操作；接收消息 id） */
  readonly onRegenerate: ((messageId: string) => void) | undefined;
  /** 当前搜索匹配消息索引（滚动定位；无匹配为 -1） */
  readonly searchActiveIndex?: number;
  /** 自定义容器类名 */
  readonly className?: string;
}

/** 距底部阈值（px）：小于该值视为"在底部" */
const AT_BOTTOM_THRESHOLD = 80;

export function ChatMessageList({
  messages,
  status,
  onRegenerate,
  searchActiveIndex = -1,
  className,
}: ChatMessageListProps): ReactElement {
  // 本地化文案
  const { t } = useTranslation();
  // 滚动容器 ref（替代 Virtuoso 句柄）
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // 是否在底部附近（ref 版本：在滚动回调中写入，避免闭包陷阱）
  const isAtBottomRef = useRef(true);

  // 是否显示"滚动到底部"按钮（距底部 > 阈值时显示）
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 是否有新消息到达且用户不在底部（按钮显示 .has-new 红点）
  const [hasNew, setHasNew] = useState(false);

  // 流式状态（streaming / submitted）时显示占位"..."
  const isStreaming = status === 'streaming' || status === 'submitted';

  // 流式占位显示条件：
  // - submitted（思考中，assistant 尚未开始输出）：总是显示打字指示
  // - streaming（已收到首个 chunk）：仅当最后一条消息不是 assistant 时显示——
  //   AI SDK v7 收到 text-start 即创建真实 assistant 消息，此时占位再显示
  //   会出现"真实消息头像 + 占位头像"双头像重复（实测 bug）
  const lastRole = messages.length > 0 ? messages[messages.length - 1]?.role : undefined;
  const showStreamingFooter = isStreaming && (status === 'submitted' || lastRole !== 'assistant');

  /**
   * 滚动回调：底部检测（替代 Virtuoso atBottomStateChange）
   *
   * - 在底部附近：隐藏按钮，清除 hasNew
   * - 不在底部：显示按钮
   */
  const handleScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
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
    const el = scrollerRef.current;
    if (el !== null) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
    setShowScrollBtn(false);
    setHasNew(false);
    isAtBottomRef.current = true;
  };

  /** 滚动到指定消息（导航轨/搜索定位；居中） */
  const scrollToIndex = useCallback((index: number): void => {
    const el = scrollerRef.current?.querySelector(`[${MSG_INDEX_ATTR}="${index}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, []);

  // 智能自动滚动：messages 长度变化或流式状态变化时触发
  // - 用户在底部附近：直接滚动跟随新内容（替代 Virtuoso followOutput）
  // - 用户不在底部：标记 hasNew（按钮显示新消息红点）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 故意监听 messages.length 与 isStreaming，触发标记而不读取其值
  useEffect(() => {
    if (isAtBottomRef.current) {
      const el = scrollerRef.current;
      if (el !== null) {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    } else {
      setHasNew(true);
    }
  }, [messages.length, isStreaming]);

  // 会话内搜索：当前匹配消息变化时滚动到该消息（居中）
  useEffect(() => {
    if (searchActiveIndex >= 0) {
      scrollToIndex(searchActiveIndex);
    }
  }, [searchActiveIndex, scrollToIndex]);

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
      {/* 消息滚动区（普通滚动渲染） */}
      <div ref={scrollerRef} className="messages h-full overflow-y-auto" onScroll={handleScroll}>
        {messages.map((message, index) => (
          <div
            key={message.id}
            {...{ [MSG_INDEX_ATTR]: index }}
            className={cn('transition-colors', index === searchActiveIndex && 'search-highlight')}
          >
            <MessageItem
              message={message}
              onRegenerate={onRegenerate}
              disableActions={isStreaming}
            />
          </div>
        ))}
        {/* 流式占位：assistant 尚未开始输出时显示打字指示（避免与真实 assistant 消息双头像重复） */}
        {showStreamingFooter && <StreamingFooter />}
      </div>
      {/* 消息导航轨（对齐原型 .msg-nav-rail：右侧点导航，点击滚动到对应消息）
          仅消息较多时显示，避免干扰 */}
      {messages.length >= 4 && (
        <ul className="msg-nav-rail visible" aria-label={t('chat.msgNavRail')}>
          {messages.map((message, index) => (
            <li key={message.id}>
              <button
                type="button"
                className="nav-dot"
                data-role={message.role}
                onClick={() => scrollToIndex(index)}
                aria-label={`${t('chat.msgNavGoTo')} ${index + 1}`}
                title={`${t('chat.msgNavGoTo')} ${index + 1}`}
              />
            </li>
          ))}
        </ul>
      )}
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
