// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · 组装层（消息行/流式尾部/操作按钮提取至独立文件）
// ──────────────────────────────────────────────
// 拆分背景（2026-08 重构）：原文件 685 行混合渲染/操作/纯函数，按职责拆分：
// - message-item.tsx：消息行渲染（PartView/工具调用/代码块/推理块）
// - streaming-footer.tsx：流式尾部（生成中/占位）
// - message-actions.tsx：消息操作（复制/重试/重新生成）
// ──────────────────────────────────────────────
// 渲染策略（2026-09-24 调整，debt.md#d2）：数据本身按回合分页（路由层
// useInfiniteQuery 增量拉取，ChatPanel 向上补页 prepend）——内存中的 messages
// 只是「已加载页」的并集，天然有界，无需再叠一层 DOM 窗口（原 message-window
// 方案 A 已移除）。滚动到顶触发 onLoadEarlier 向上补页，锚定补偿见
// pendingAnchorRef（scrollHeight 增量回补，与补页渲染解耦）。
// 消息渲染正确性优先；流式场景下 MessageItem 内部按消息 id 记忆化，仅变化
// 消息重渲染。
// ──────────────────────────────────────────────

import type { UIMessage } from 'ai';
import { ChevronDown, Sparkles } from 'lucide-react';
import { type ReactElement, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { EmptyState } from '@/components/common/EmptyState';
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

  // 向上补页锚定：触发时记录 scrollHeight，补页内容渲染后按增量回补 scrollTop
  // （与补页的两段提交解耦：只要检测到内容增长且 pending 在位即补偿一次）
  const pendingAnchorRef = useRef<number | null>(null);

  // 滚动事件合帧（2026-09 优化）：rAF 内只执行一次状态更新 + 分页判定，
  // 避免单次滚动事件同步多次 setState（对齐 useMessageNavRail.scheduleSync 模式）。
  const scrollFrameRef = useRef<number | null>(null);
  const pendingHasNewRef = useRef(false);

  /** 滚动到顶判定（rAF 帧内执行）：仍有更早回合且不在加载中 → 触发补页 */
  // 引用稳定性交给 React Compiler
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

  // 补页锚定补偿：内容增长（prepend 渲染完成）且 pending 在位 → 回补 scrollTop；
  // 补页结束但内容未增长（空页/失败）→ 放弃补偿，避免悬挂的 pending 误判
  // 后续流式 append。behavior:'instant'：容器 CSS scroll-behavior:smooth 会让
  // scrollTop 赋值走平滑动画，动画期间再次触发到顶判定 → 连翻数页。
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
    // 仅在回到底部时清位；"不在底部"的置位由 auto-scroll effect 负责——
    // 此处置位会让单纯向上翻看历史也点亮"新消息"红点（语义漂移）
    if (atBottom) {
      pendingHasNewRef.current = false;
    }
    // 导航轨滚动联动：合帧更新活跃圆点（其实现内部已 rAF 合帧）
    scheduleSync();
    scheduleScrollFrame();
  };

  /** 合帧执行滚动派生状态更新（每帧至多一次） */
  // 引用稳定性交给 React Compiler
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

  /** 滚动到指定消息（导航轨/搜索定位；居中）。目标未渲染（未加载的更早回合）时静默——
   *  搜索/跳转覆盖面 = 已加载页（debt.md#d2 既有取舍） */
  const scrollToIndex = (index: number): void => {
    const el = scrollerRef.current?.querySelector(`[${MSG_INDEX_ATTR}="${index}"]`) ?? null;
    if (el !== null) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };
  // effect 依赖用 ref 调最新实现：scrollToIndex 每 render 新建，进依赖会让
  // 搜索定位 effect 跟着无关渲染重跑（vitest 无 Compiler，不能赌自动记忆化）
  const scrollToIndexRef = useRef(scrollToIndex);
  scrollToIndexRef.current = scrollToIndex;

  // 会话内搜索：当前匹配消息变化时滚动到该消息（居中）
  useEffect(() => {
    if (searchActiveIndex >= 0) {
      scrollToIndexRef.current(searchActiveIndex);
    }
  }, [searchActiveIndex]);

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

  // 空状态：无消息时展示 EmptyState（hooks 规则：所有 hook 已在早退 return 之前声明）
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
          {/* 向上补页指示：加载中显示 spinner 文案；仍有更早回合时提示可上滚 */}
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
