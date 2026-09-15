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
import {
  type ReactElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { EmptyState } from '@/components/common/EmptyState';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { MessageItem } from './message-item';
import { clampStart, ensureIndexStart, initialWindowStart, nextPageStart } from './message-window';
import { QuestionJumpBar } from './question-jump-bar';
import { StreamingFooter } from './streaming-footer';
import { MSG_INDEX_ATTR, useMessageNavRail } from './use-message-nav-rail';

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

/** 距顶部阈值（px）：小于该值且窗口未到开头时加载更早消息（分页渲染） */
const AT_TOP_THRESHOLD = 200;

/** 消息列表 live region（2026-09-08 a11y：流式增量对读屏可见，不逐 token 刷屏） */
const MESSAGE_LIST_LIVE_PROPS = {
  'aria-live': 'polite',
  'aria-atomic': 'false',
  'aria-relevant': 'additions text',
} as const;

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
  // 是否在底部附近（ref：滚动回调写入，避免闭包陷阱）
  const isAtBottomRef = useRef(true);
  // 是否显示"滚动到底部"按钮（距底部 > 阈值时显示）
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 是否有新消息到达且用户不在底部（按钮显示 .has-new 红点）
  const [hasNew, setHasNew] = useState(false);

  // 流式状态（streaming / submitted）时显示占位"..."
  const isStreaming = status === 'streaming' || status === 'submitted';

  // 分页渲染窗口（2026-08 长会话性能根治）：数据全量保留在 messages（LLM 上下文
  // 完整），仅裁剪 DOM——默认只渲染最近一页，滚动到顶加载更早；首屏挂载成本固定
  const [windowStart, setWindowStart] = useState<number>(() => initialWindowStart(messages.length));
  // 实际渲染起点：state 越界时回退默认窗口；slice / 索引基线 / 计数统一用它
  const clampedStart = clampStart(windowStart, messages.length);
  // 加载更早前的滚动高度（渲染后补偿，保持视口内容不跳）
  const prevScrollHeightRef = useRef(0);
  // 目标在窗口外时的待滚动索引（窗口扩展渲染后执行）
  const pendingScrollIndexRef = useRef<number | null>(null);

  /** 加载更早一页消息（滚动到顶触发；锚定补偿由 useLayoutEffect 处理） */
  const loadEarlier = useCallback((): void => {
    setWindowStart((prev) => nextPageStart(prev));
  }, []);

  // 滚动事件合帧（2026-09 优化）：rAF 内只执行一次状态更新 + 分页判定，
  // 避免单次滚动事件同步多次 setState（对齐 useMessageNavRail.scheduleSync 模式）。
  // 底部按钮/新消息标记/分页加载是"帧级"状态，无需每滚动事件实时。
  const scrollFrameRef = useRef<number | null>(null);
  const pendingHasNewRef = useRef(false);

  // 会话切换（messages 骤变）时重置窗口；流式 append（长度增长）不重置
  useEffect(() => {
    setWindowStart((prev) => {
      if (messages.length === 0) return 0;
      return prev >= messages.length ? initialWindowStart(messages.length) : prev;
    });
  }, [messages.length]);

  // 加载更早后补偿滚动位置（保持视口内容不跳）
  // biome-ignore lint/correctness/useExhaustiveDependencies: windowStart 变化需重跑补偿（窗口扩展后重算 scrollTop）
  useLayoutEffect(() => {
    if (prevScrollHeightRef.current > 0) {
      const el = scrollerRef.current;
      if (el !== null) {
        // behavior:'instant' 显式瞬时：容器 CSS scroll-behavior:smooth 会让
        // scrollTop 赋值走平滑动画，动画期间再次触发到顶判定 → 连翻数页
        el.scrollTo({
          top: el.scrollTop + (el.scrollHeight - prevScrollHeightRef.current),
          behavior: 'instant',
        });
      }
      prevScrollHeightRef.current = 0;
    }
  }, [windowStart]);

  // 流式占位显示条件：
  // - submitted（思考中，assistant 尚未开始输出）：总是显示打字指示
  // - streaming（已收到首个 chunk）：仅当最后一条消息不是 assistant 时显示——
  //   AI SDK v7 收到 text-start 即创建真实 assistant 消息，此时占位再显示
  //   会出现"真实消息头像 + 占位头像"双头像重复（实测 bug）
  const lastRole = messages.length > 0 ? messages[messages.length - 1]?.role : undefined;
  const showStreamingFooter = isStreaming && (status === 'submitted' || lastRole !== 'assistant');

  // 导航轨（锚点 + 滚动联动活跃圆点）状态提取至独立 hook，本组件只负责消费与滚动定位
  const { questions, activeTurn, scheduleSync } = useMessageNavRail({
    messages,
    windowStart: clampedStart,
    scrollerRef,
  });

  /**
   * 滚动回调：底部检测 + 分页加载（rAF 合帧，2026-09 优化）
   *
   * 替代 Virtuoso atBottomStateChange。isAtBottomRef 是最实时语义（滚动回调内
   * 同步写入，供流式自动滚动/分页补偿读取）；UI 反映（按钮显隐、新消息红点）
   * 与分页加载统一推迟到下一帧执行一次，避免滚动事件风暴下多次 setState。
   */
  const handleScroll = (): void => {
    const el = scrollerRef.current;
    if (el === null) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD;
    isAtBottomRef.current = atBottom;
    // 仅在回到底部时清位；"不在底部"的置位由 auto-scroll effect 负责——
    // 此处置位会让单纯向上翻看历史也点亮"新消息"红点（语义漂移）
    if (atBottom) {
      pendingHasNewRef.current = false;
    }

    // 分页渲染：滚动到顶部附近且窗口未到开头 → 加载更早（记录高度供补偿）。
    // 移到 rAF 帧内执行，避免单次滚动事件重复触发 loadEarlier（clampedStart>0
    // 已有约束：窗口推进后 clampedStart 变小，自然不再命中，合帧只为收敛状态写入）。
    if (el.scrollTop <= AT_TOP_THRESHOLD && clampedStart > 0) {
      prevScrollHeightRef.current = el.scrollHeight;
    }
    // 导航轨滚动联动：合帧更新活跃圆点（其实现内部已 rAF 合帧）
    scheduleSync();
    scheduleScrollFrame();
  };

  /** 合帧执行滚动派生状态更新（每帧至多一次） */
  const scheduleScrollFrame = useCallback((): void => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const el = scrollerRef.current;
      if (el !== null) {
        setShowScrollBtn(
          !(el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_THRESHOLD),
        );
        setHasNew(pendingHasNewRef.current);
        if (el.scrollTop <= AT_TOP_THRESHOLD && clampedStart > 0) {
          loadEarlier();
        }
      }
    });
  }, [clampedStart, loadEarlier]);

  // 组件卸载时取消挂起帧（防 setState on unmounted）
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

  /** 滚动到指定消息（导航轨/搜索定位；居中）；目标在窗口外时先扩展窗口 */
  const scrollToIndex = useCallback((index: number): void => {
    const el = scrollerRef.current?.querySelector(`[${MSG_INDEX_ATTR}="${index}"]`) ?? null;
    if (el !== null) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    // 目标未渲染（分页窗口外）：扩展窗口后由 effect 执行滚动
    pendingScrollIndexRef.current = index;
    setWindowStart((prev) => ensureIndexStart(index, prev));
  }, []);

  // 窗口扩展渲染后执行待滚动（导航轨/搜索跳转到窗口外消息）
  // biome-ignore lint/correctness/useExhaustiveDependencies: windowStart 变化需重跑（扩展渲染后才找得到目标节点）
  useEffect(() => {
    const pending = pendingScrollIndexRef.current;
    if (pending === null) return;
    const el = scrollerRef.current?.querySelector(`[${MSG_INDEX_ATTR}="${pending}"]`) ?? null;
    if (el !== null) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      pendingScrollIndexRef.current = null;
    }
  }, [windowStart]);

  // 渲染窗口裁剪：数据全量在 messages，仅 DOM 层分页（起点口径统一见 clampedStart）
  const visibleMessages = useMemo(() => messages.slice(clampedStart), [messages, clampedStart]);

  // 智能自动滚动：messages 身份变化（流式期间每个合帧 chunk 都产生新数组——
  // delta 合并进同一条消息，length 不变，仅监听 length 会让视口在长回复
  // 流式时停在开头）或流式状态变化时触发
  // - 用户在底部附近：直接滚动跟随新内容（替代 Virtuoso followOutput）
  // - 用户不在底部：标记 hasNew（按钮显示新消息红点）
  // 瞬时定位（behavior:'instant'）：容器 CSS smooth 会让赋值走动画，高频
  // chunk 下持续滚动重排；用户显式点击按钮仍走 smooth（scrollToBottom）
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
      {/* data-testid 供 e2e/perf/render.bench.spec.ts 布局基准与 DOM 节点断言定位 */}
      <div
        ref={scrollerRef}
        data-testid="chat-message-list"
        className="messages h-full overflow-y-auto"
        onScroll={handleScroll}
        {...MESSAGE_LIST_LIVE_PROPS}
      >
        {/* 居中限宽容器（CSS .messages-inner 已定义但此前从未渲染——消息通栏全宽，
            与 820px 居中的输入框严重错位） */}
        <div className="messages-inner">
          {/* 分页提示：窗口未到开头（滚动到顶可加载更早消息） */}
          {clampedStart > 0 && (
            <div className="text-muted-foreground/60 py-1 text-center text-2xs">
              {t('chat.loadedMessages', {
                count: messages.length - clampedStart,
                total: messages.length,
              })}
            </div>
          )}
          {visibleMessages.map((message, relativeIndex) => {
            // 全量索引（流式标记/连续判定/MSG_INDEX_ATTR 用）
            const index = clampedStart + relativeIndex;
            // 流式标记：最后一条 assistant 消息正在输出时，文本末尾显示闪烁光标（照搬参考项目 StreamingCursor）
            const isStreamingMessage =
              !showStreamingFooter && isStreaming && index === messages.length - 1;
            // 连续 assistant 消息：前一条也是 assistant（隐藏头像与角色标签，照搬参考项目 isContinuation）
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
          {/* 流式占位：assistant 尚未开始输出时显示打字指示（避免与真实 assistant 消息双头像重复） */}
          {showStreamingFooter && <StreamingFooter />}
        </div>
      </div>
      {/* 消息跳转条（对齐参考项目 QuestionJumpBar：磁性吸附横条 + 整轨热区 + 预览跟随）
          仅当用户消息 ≥2 条时显示；挂在与 .messages 同级的相对容器上 */}
      {questions.length >= 2 && (
        <QuestionJumpBar
          questions={questions}
          activeTurn={activeTurn}
          onJump={(question) => scrollToIndex(question.messageIndex)}
        />
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
