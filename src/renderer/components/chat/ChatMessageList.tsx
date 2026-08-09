// src/renderer/components/chat/ChatMessageList.tsx
// 聊天消息列表 · 组装层（消息行/流式尾部/操作按钮提取至独立文件）
// ──────────────────────────────────────────────
// 拆分背景（2026-08 重构）：原文件 685 行混合渲染/操作/纯函数，按职责拆分：
// - message-item.tsx：消息行渲染（PartView/工具调用/代码块/推理块）
// - streaming-footer.tsx：流式尾部（生成中/占位）
// - message-actions.tsx：消息操作按钮
// - message-utils.ts：纯函数（状态映射/文本提取/JSON 格式化）
// ──────────────────────────────────────────────

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
import { ChevronDown, Sparkles } from 'lucide-react';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';

import { EmptyState } from '@/components/common/EmptyState';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

import { MessageItem } from './message-item';
import { StreamingFooter } from './streaming-footer';

/** ChatMessageList props */
export interface ChatMessageListProps {
  /** 消息数组（来自 useChat().messages） */
  readonly messages: readonly UIMessage[];
  /** 当前流式状态（'streaming' / 'submitted' 时显示流式占位） */
  readonly status: 'submitted' | 'streaming' | 'ready' | 'error';
  /** 重新生成指定 assistant 消息 */
  readonly onRegenerate: (messageId: string) => void;
  /** 搜索当前匹配消息索引（会话内搜索；-1 = 无匹配/搜索关闭） */
  readonly searchActiveIndex?: number;
  /** 附加 className */
  readonly className?: string;
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

  // 会话内搜索：当前匹配消息变化时滚动到该消息（居中）
  useEffect(() => {
    if (searchActiveIndex >= 0) {
      virtuosoRef.current?.scrollToIndex({
        index: searchActiveIndex,
        align: 'center',
        behavior: 'smooth',
      });
    }
  }, [searchActiveIndex]);

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
        itemContent={(index, message) => (
          <div
            className={cn('transition-colors', index === searchActiveIndex && 'search-highlight')}
          >
            <MessageItem
              message={message}
              onRegenerate={onRegenerate}
              disableActions={isStreaming}
            />
          </div>
        )}
        // 流式占位：assistant 正在响应时渲染在列表尾部（Footer 插槽）
        // biome-ignore lint/style/useNamingConvention: Virtuoso Components 接口的 Footer 字段为 PascalCase
        {...(isStreaming ? { components: { Footer: StreamingFooter } } : {})}
      />
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
                onClick={() =>
                  virtuosoRef.current?.scrollToIndex({
                    index,
                    align: 'center',
                    behavior: 'smooth',
                  })
                }
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

/** Virtuoso Footer 插槽：流式占位（assistant 正在响应时显示 typing-indicator） */
