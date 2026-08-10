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
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { MessageItem } from './message-item';
import { extractText } from './message-utils';
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

/** 导航圆点数量上限（对齐参考项目：超过时按比例映射，避免溢出） */
const MAX_NAV_DOTS = 10;

/** 导航圆点渲染数据 */
interface NavDot {
  /** React key */
  readonly key: string;
  /** 用户消息序号（0-based，aria-label/tooltip 用） */
  readonly userIndex: number;
  /** 消息列表中的索引（点击滚动用） */
  readonly messageIndex: number;
  /** 是否活跃（滚动联动） */
  readonly isActive: boolean;
  /** 用户消息内容预览（tooltip 展示，截断） */
  readonly preview: string;
}

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

  // 导航轨数据源：用户消息位置（对齐参考项目 VerticalProgressBar——圆点代表用户消息而非每条消息）
  const userMessageIndices = useMemo(
    () => messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0),
    [messages],
  );

  // 滚动联动的活跃用户消息序（0-based；null = 无活跃）
  const [activeUserIndex, setActiveUserIndex] = useState<number | null>(null);

  // 导航圆点：未超上限全量展示（活跃 = 序号相等）；超过 MAX_NAV_DOTS 按比例映射
  // （对齐参考项目 I-M-012，active 用区间 [srcIdx, nextSrcIdx) 判断，避免映射后索引错位）
  const navDots = useMemo<readonly NavDot[]>(() => {
    const n = userMessageIndices.length;
    if (n === 0) return [];
    // 预览：用户消息文本（对齐参考实现 hover peek 内容；截断 60 字符）
    const previewOf = (messageIndex: number): string => {
      const text = extractText(messages[messageIndex]?.parts ?? []);
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    };
    if (n <= MAX_NAV_DOTS) {
      return userMessageIndices.map((messageIndex, i) => ({
        key: `dot-${i}`,
        userIndex: i,
        messageIndex,
        isActive: activeUserIndex === i,
        preview: previewOf(messageIndex),
      }));
    }
    return Array.from({ length: MAX_NAV_DOTS }, (_, dotIdx) => {
      const srcIdx = Math.min(Math.floor((dotIdx * n) / MAX_NAV_DOTS), n - 1);
      const nextSrcIdx = Math.min(Math.floor(((dotIdx + 1) * n) / MAX_NAV_DOTS), n - 1);
      const isActive =
        activeUserIndex !== null &&
        srcIdx <= activeUserIndex &&
        (dotIdx === MAX_NAV_DOTS - 1 || nextSrcIdx > activeUserIndex);
      return {
        key: `dot-${dotIdx}`,
        userIndex: srcIdx,
        messageIndex: userMessageIndices[srcIdx] ?? -1,
        isActive,
        preview: previewOf(userMessageIndices[srcIdx] ?? -1),
      };
    });
  }, [userMessageIndices, activeUserIndex, messages]);

  /**
   * 滚动回调：底部检测（替代 Virtuoso atBottomStateChange）
   *
   * - 在底部附近：隐藏按钮，清除 hasNew
   * - 不在底部：显示按钮
   */
  // 导航轨滚动联动（对齐参考项目 I-M-011）：视口中线对应的最后一条消息
  // → 其之前最近的用户消息 → 返回用户消息序（null = 无活跃）
  const computeActiveUserIndex = useCallback(
    (el: HTMLElement): number | null => {
      const midpoint = el.scrollTop + el.clientHeight / 2;
      let activeMsgIndex = -1;
      for (const node of el.querySelectorAll(`[${MSG_INDEX_ATTR}]`)) {
        const msgIndex = Number(node.getAttribute(MSG_INDEX_ATTR));
        const top = (node as HTMLElement).offsetTop;
        if (msgIndex > activeMsgIndex && top <= midpoint) {
          activeMsgIndex = msgIndex;
        }
      }
      const lastUserMsgIndex =
        activeMsgIndex >= 0
          ? [...userMessageIndices].reverse().find((idx) => idx <= activeMsgIndex)
          : undefined;
      return lastUserMsgIndex !== undefined ? userMessageIndices.indexOf(lastUserMsgIndex) : null;
    },
    [userMessageIndices],
  );

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

    // 导航轨滚动联动：更新活跃圆点（相同值不触发重渲染）
    const nextActive = computeActiveUserIndex(el);
    setActiveUserIndex((prev) => (prev === nextActive ? prev : nextActive));
  };

  // 初始/用户消息数变化时同步一次活跃圆点（内容不满一屏时无滚动事件，
  // 挂载即按当前视口计算，保证底部场景下最后一个圆点默认高亮）
  useEffect(() => {
    const el = scrollerRef.current;
    if (el === null) return;
    const nextActive = computeActiveUserIndex(el);
    setActiveUserIndex((prev) => (prev === nextActive ? prev : nextActive));
  }, [computeActiveUserIndex]);

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
      {/* 消息导航轨（对齐参考项目 VerticalProgressBar：圆点代表用户消息位置，
          竖线连接、滚动联动高亮、hover tooltip、数量上限 10 比例映射）
          仅当用户消息 ≥2 条时显示（对齐参考项目：少于 2 条无导航意义） */}
      {userMessageIndices.length >= 2 && (
        <ul className="msg-nav-rail visible" aria-label={t('chat.msgNavRail')}>
          {/* 竖线连接所有圆点 */}
          <li className="nav-rail-line" aria-hidden="true" />
          {navDots.map((dot) => (
            <li key={dot.key}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="nav-dot"
                    data-active={dot.isActive}
                    data-role="user"
                    onClick={() => scrollToIndex(dot.messageIndex)}
                    aria-label={`${t('chat.msgNavGoTo')} ${dot.userIndex + 1}`}
                  />
                </TooltipTrigger>
                <TooltipContent side="left">
                  <span className="block truncate">{`${t('chat.msgNavGoTo')} ${dot.userIndex + 1}`}</span>
                  {dot.preview !== '' && (
                    <span className="text-muted-foreground mt-0.5 block max-w-[200px] truncate text-2xs">
                      {dot.preview}
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
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
