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
  type CSSProperties,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { EmptyState } from '@/components/common/EmptyState';
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

/** 用户消息预览截断长度（跳转条预览） */
const PREVIEW_MAX_CHARS = 60;

/** 跳转条锚点（对齐参考项目 QuestionAnchor：每个用户消息一个锚点） */
interface QuestionAnchor {
  /** React key（消息索引派生） */
  readonly id: string;
  /** 用户消息序号（0-based） */
  readonly turn: number;
  /** 消息列表索引（点击滚动用） */
  readonly messageIndex: number;
  /** 用户消息内容预览（截断） */
  readonly text: string;
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

  // 跳转条锚点：全量用户消息（对齐参考项目 QuestionAnchor——跳转条内部滚动承载，无需比例映射）
  const questions = useMemo<readonly QuestionAnchor[]>(() => {
    return userMessageIndices.map((messageIndex, i) => {
      const text = extractText(messages[messageIndex]?.parts ?? []);
      return {
        id: `q-${messageIndex}`,
        turn: i,
        messageIndex,
        text: text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text,
      };
    });
  }, [userMessageIndices, messages]);

  /**
   * 滚动回调：底部检测（替代 Virtuoso atBottomStateChange）
   *
   * - 在底部附近：隐藏按钮，清除 hasNew
   * - 不在底部：显示按钮
   */
  // 导航轨滚动联动（对齐参考项目 I-M-011）：视口中线对应的最后一条消息  // → 其之前最近的用户消息 → 返回用户消息序（null = 无活跃）
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
        {/* 居中限宽容器（CSS .messages-inner 已定义但此前从未渲染——消息通栏全宽，
            与 820px 居中的输入框严重错位） */}
        <div className="messages-inner">
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
          activeTurn={activeUserIndex}
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

// ── 消息跳转条（对齐参考项目 DeepSeek-Reasonix QuestionJumpBar） ──────────────
// 设计：磁性吸附（hover 按距离涟漪放大）+ 整轨热区（吸附最近锚点）+ 预览跟随鼠标

interface QuestionJumpBarProps {
  /** 用户消息锚点（全量） */
  readonly questions: readonly QuestionAnchor[];
  /** 当前活跃锚点 turn（滚动联动） */
  readonly activeTurn: number | null;
  /** 跳转回调（平滑滚动到消息） */
  readonly onJump: (question: QuestionAnchor) => void;
}

/**
 * 消息跳转条
 *
 * 磁性吸附横条：鼠标在轨道上移动时按距离涟漪放大（最近 32px / 相邻 20px / 隔 1 个 14px），
 * 颜色按距离递减；预览跟随鼠标位置（role=tooltip）。
 * ──────────────────────────────
 * 变体：无
 * 状态：hovered（磁性目标）/ active（滚动联动）
 * 依赖：无（原生 div/button）
 * 可访问性：nav + button 键盘可达；jump-item focus-visible 光环；预览 role=tooltip
 * 备注：预览不用 shadcn Tooltip——Radix Tooltip 锚定触发器，无法实现"位置跟随鼠标"
 *       语义（参考项目同款交互），故用自研 div + role=tooltip（功能性例外）
 * ──────────────────────────────
 */
function QuestionJumpBar({ questions, activeTurn, onJump }: QuestionJumpBarProps): ReactElement {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const previewTop = useRef(0);
  const [showPreview, setShowPreview] = useState(false);

  const hoverIdx = hovered !== null ? questions.findIndex((q) => q.turn === hovered) : -1;
  const hoveredQuestion = hovered !== null ? questions.find((q) => q.turn === hovered) : undefined;

  /** 吸附：找到离指针最近的锚点（整轨热区——无需精确点中横条） */
  const closestQuestionFromY = (
    clientY: number,
  ): { question: QuestionAnchor; previewY: number } | null => {
    const el = barRef.current;
    if (el === null) return null;
    const markers = el.querySelectorAll<HTMLElement>('.jump-item');
    const barRect = el.getBoundingClientRect();
    let closest = -1;
    let closestDist = Infinity;
    let closestY = 0;
    markers.forEach((item, index) => {
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - midY);
      if (dist < closestDist) {
        closestDist = dist;
        closest = index;
        closestY = midY - barRect.top;
      }
    });
    const question = questions[closest];
    if (question === undefined) return null;
    return { question, previewY: closestY };
  };

  const onMove = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const closest = closestQuestionFromY(e.clientY);
    if (closest === null) return;
    previewTop.current = closest.previewY;
    setHovered(closest.question.turn);
    setShowPreview(true);
  };

  const scrollTo = (question: QuestionAnchor): void => {
    onJump(question);
  };

  const onRailMouseDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const closest = closestQuestionFromY(e.clientY);
    if (closest === null) return;
    e.preventDefault();
    previewTop.current = closest.previewY;
    setHovered(closest.question.turn);
    setShowPreview(true);
    scrollTo(closest.question);
  };

  const onItemMouseDown = (
    e: ReactMouseEvent<HTMLButtonElement>,
    question: QuestionAnchor,
  ): void => {
    e.preventDefault();
    scrollTo(question);
  };

  /** 磁性宽度/颜色：未 hover 时仅 active 加宽；hover 时按距离涟漪级联（transitionDelay 错峰） */
  const dotProps = (idx: number, turn: number): { style: CSSProperties; 'data-d'?: string } => {
    const isActive = activeTurn === turn;
    if (hoverIdx < 0) {
      return isActive
        ? { style: { width: 18, background: 'var(--accent)' } }
        : { style: { width: 12 } };
    }
    const d = Math.abs(idx - hoverIdx);
    const width = d === 0 ? 32 : d === 1 ? 20 : d === 2 ? 14 : isActive ? 18 : 12;
    const background = d <= 2 ? undefined : isActive ? 'var(--accent)' : undefined;
    return {
      style: {
        width,
        transitionDelay: `${d * 20}ms`,
        ...(background !== undefined ? { background } : {}),
      },
      ...(d <= 2 ? { 'data-d': String(d) } : {}),
    };
  };

  return (
    <nav
      className="jump-bar"
      ref={barRef}
      aria-label={t('chat.msgNavRail')}
      onMouseMove={onMove}
      onMouseLeave={() => {
        setHovered(null);
        setShowPreview(false);
      }}
    >
      {/* 轨道：整轨热区（吸附最近锚点点击跳转）；键盘路径由内部 jump-item button 提供，
          轨道点击为鼠标增强（对齐参考项目同款交互） */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 有 role=group 容器语义，真实交互元素为内部 button */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: 键盘用户通过内部 jump-item 的 Enter/Space 跳转，轨道点击是鼠标增强路径 */}
      <div
        role="group"
        className="jump-scroll"
        onMouseDown={onRailMouseDown}
        onClick={onRailMouseDown}
      >
        {questions.map((question, index) => (
          <button
            className="jump-item"
            key={question.id}
            type="button"
            data-turn={question.turn}
            aria-label={`${t('chat.msgNavGoTo')} ${question.turn + 1}`}
            onMouseDown={(e) => onItemMouseDown(e, question)}
            onClick={(e) => {
              e.stopPropagation();
              // 键盘 Enter/Space 触发（e.detail === 0）；鼠标路径走 onMouseDown 避免与轨道点击冲突
              if (e.detail === 0) scrollTo(question);
            }}
          >
            <span className="jump-dot" {...dotProps(index, question.turn)} />
          </button>
        ))}
      </div>
      {showPreview && hoveredQuestion !== undefined && (
        <div className="jump-preview" style={{ top: previewTop.current }} role="tooltip">
          <span className="jump-text">{hoveredQuestion.text}</span>
        </div>
      )}
    </nav>
  );
}
