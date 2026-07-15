/**
 * MessageList — 消息流列表
 *
 * 对应 prototype.html 的 `.messages` + `.messages-inner` 结构。
 * 功能：
 * - 可滚动的消息列表（使用 ScrollArea 组件）
 * - 新消息到达时自动滚动到底部
 * - 渲染 MessageBubble 列表（支持 text/tool_call/file_change/thinking/approval 等类型）
 * - 支持 assistant 连续消息合并（隐藏重复头像和角色标签）
 * - 流式输出时显示 TypingIndicator
 * - 从 streaming-store 获取实时流式内容并合并显示
 * - M1: 滚动脱离底部时显示"滚动到底部"按钮（对齐原型 .scroll-to-bottom）
 * - I-G-011: 支持搜索高亮（匹配项 ring-1，当前匹配项 ring-2 + scrollIntoView）
 * - I-M-010: 注册滚动到指定消息的函数（供进度条圆点点击调用）
 * - I-M-011: 滚动时计算并通知当前可视区域的活跃用户消息索引
 * - I-M-013: 滚动事件使用 requestAnimationFrame 节流
 *
 * 参考样式：prototype.html 第 612-707 行（.messages / .messages-inner）
 *           prototype.html 第 894-923 行（.scroll-to-bottom 滚动按钮）
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { Message, ThreadId } from '@/lib/codex/types'
import { ScrollArea } from '@/components/ui/scroll-area'
import { MessageBubble } from './MessageBubble'
import { TypingIndicator } from './TypingIndicator'
import { useStreamingStore, buildMessageFromItem } from '@/store/streaming-store'
import { cn } from '@/lib/utils'

/**
 * 滚动到底部按钮的显示阈值（px）。
 * 当用户滚动位置距底部超过此值时，显示"滚动到底部"按钮。
 * 对齐原型 .scroll-to-bottom 的显示逻辑。
 */
// 对齐原型 prototype.html L16915：距底部 80px 即显示"滚动到底部"按钮
// （原前端为 120px，改为 80px 对齐原型阈值）
const SCROLL_TO_BOTTOM_THRESHOLD = 80

export interface MessageListProps {
  /** 消息列表 */
  messages: Message[]
  /** 当前 thread ID（用于订阅流式状态） */
  threadId?: ThreadId
  /** 可选的模型名（传递给 MessageBubble 显示在角色标签中） */
  modelName?: string
  /** 是否正在加载（显示加载占位） */
  isLoading?: boolean
  /** 审批操作回调（传递给 MessageBubble 的内联审批卡片） */
  onApprovalAction?:
    | ((
        requestId: string,
        action: 'approve' | 'reject' | 'whitelist'
      ) => void)
    | undefined
  className?: string
  /** I-G-011: 搜索匹配的消息 ID 列表（添加高亮 ring） */
  highlightedMessageIds?: string[]
  /**
   * I-G-011: 当前定位到的匹配消息 ID（更强高亮 + scrollIntoView）。
   * null 表示无当前匹配项。
   * 使用 string | null 而非可选属性，兼容 exactOptionalPropertyTypes。
   */
  currentHighlightId?: string | null
  /** I-M-011: 滚动时通知父组件当前可视区域的活跃用户消息索引 */
  onScrollActiveIndex?: (index: number | null) => void
  /** P0-3: 重新生成回调（传递给 MessageBubble 的重新生成按钮） */
  onRegenerate?: (messageId: string) => void
  /**
   * I-M-010: 滚动到指定消息的函数引用（由 MessageList 注册）。
   * 父组件持有此 ref，进度条圆点点击时调用 ref.current(messageId) 滚动到对应消息。
   */
  scrollToMessageRef?: React.RefObject<((messageId: string) => void) | null>
}

/**
 * 消息流列表组件。
 *
 * 自动滚动逻辑：
 *   新消息到达时通过底部锚点的 scrollIntoView 滚动到底部。
 *   scrollIntoView 会自动找到最近的滚动容器（ScrollArea 的 Viewport）。
 *
 * 流式渲染逻辑：
 *   从 streaming-store 获取当前活跃的流式消息，
 *   追加到已有消息列表末尾合并显示。
 *
 * 滚动节流（I-M-013）：
 *   使用 requestAnimationFrame 对 scroll 事件进行节流，
 *   每帧最多执行一次计算，避免高频滚动导致主线程卡顿。
 */
export function MessageList({
  messages,
  threadId,
  modelName,
  isLoading = false,
  onApprovalAction,
  className,
  highlightedMessageIds,
  currentHighlightId,
  onScrollActiveIndex,
  scrollToMessageRef,
  onRegenerate,
}: MessageListProps) {
  // 底部锚点元素，用于滚动定位
  const bottomRef = useRef<HTMLDivElement | null>(null)

  // ---- M1: 滚动到底部按钮相关状态 ----
  // ScrollArea 外层容器引用，用于查找内部 viewport 滚动元素
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  // I-M-013: viewport 元素引用（供 RAF 节流的 handleScroll 读取，避免 stale closure）
  const viewportRef = useRef<HTMLElement | null>(null)
  // 是否显示"滚动到底部"按钮（滚动脱离底部超过阈值时显示）
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  // M1: 是否有未读新消息（用户滚动脱离底部后有新消息到达时为 true，回到底部或点击按钮后为 false）
  // 对齐原型 .scroll-to-bottom.has-new .new-msg-dot { display:block }（仅有新消息时显示红点）
  const [hasNewMessages, setHasNewMessages] = useState(false)
  // 跟踪用户是否在底部附近（ref 避免 stale closure，供新消息检测读取最新值）
  const isAtBottomRef = useRef(true)

  // ---- Bug 2: 切换线程时重置滚动相关 UI 状态 ----
  // 采用 React 推荐的"在渲染期间调整 state 以响应 prop 变化"模式
  // （见 https://react.dev/reference/react/useState#storing-information-from-previous-renders ）。
  // 在渲染期间（而非 effect 中）调用 setState 可避免级联渲染，
  // 也不触发 react-hooks/set-state-in-effect 规则。
  // 背景：在线程 A 中向上滚动后切到线程 B，showScrollToBottom / hasNewMessages 仍为旧值，
  // 需在切换时重置，确保新线程从"已在底部、无未读"的初始状态开始。
  const [prevThreadId, setPrevThreadId] = useState<ThreadId | undefined>(threadId)
  if (threadId !== prevThreadId) {
    // 同步更新 prevThreadId 防止无限循环：更新后 threadId === prevThreadId，下次渲染不再进入
    setPrevThreadId(threadId)
    setShowScrollToBottom(false)
    setHasNewMessages(false)
  }

  // ---- I-M-013: RAF 节流 ----
  // 非空表示已有待执行的帧回调，跳过本次调度；帧回调执行后置空
  const rafIdRef = useRef<number | null>(null)

  // ---- I-M-011: 活跃用户消息索引回调引用 ----
  // 使用 ref 持有最新回调，使 handleScroll 保持稳定引用（不依赖 onScrollActiveIndex 变化）
  // 在 effect 中同步最新回调，避免在渲染期间变更 ref（react-hooks/refs 规则）
  const onScrollActiveIndexRef = useRef(onScrollActiveIndex)
  useEffect(() => {
    onScrollActiveIndexRef.current = onScrollActiveIndex
  }, [onScrollActiveIndex])

  // ---- I-G-011: 当前高亮匹配项的元素引用（用于 scrollIntoView） ----
  const currentHighlightRef = useRef<HTMLDivElement | null>(null)

  // ---- 从 streaming-store 获取流式状态 ----
  const isStreaming = useStreamingStore(s => s.isStreaming)
  const streamingItems = useStreamingStore(s => s.streamingItems)
  const activeStreamingThread = useStreamingStore(
    s => s.activeStreamingThread
  )

  // 判断当前 thread 是否正在流式输出
  const isCurrentThreadStreaming =
    isStreaming && activeStreamingThread === threadId

  // 将流式缓冲区中的消息转为 Message[] 追加到列表末尾
  // 复用 streaming-store 的 buildMessageFromItem，保留完整的结构化内容
  // （reasoning / toolCalls / fileChanges / planItems / approval），
  // 并覆盖 id 和 timestamp 以区分流式预览与最终归档消息：
  // - id 加 `streaming-` 前缀，避免与归档后的 Message.id 冲突
  // - timestamp 使用 item.startedAt（条目创建时记录），
  //   避免在渲染期间调用 Date.now()（react-compiler 纯性规则）
  // - isStreaming 标记为 true（buildMessageFromItem 默认设为 false，此处覆盖）
  // 使用 useMemo 避免每次渲染创建新数组，否则依赖 allMessages 的 useMemo 会失效
  const streamingMessages = useMemo<Message[]>(
    () =>
      isCurrentThreadStreaming
        ? Object.values(streamingItems)
            .filter(item => item.isStreaming)
            .map(item => {
              const baseMessage = buildMessageFromItem(item)
              return {
                ...baseMessage,
                id: `streaming-${item.itemId}`,
                timestamp: item.startedAt,
                isStreaming: true,
              }
            })
        : [],
    [isCurrentThreadStreaming, streamingItems]
  )

  // 合并已有消息 + 流式消息
  // 使用 useMemo 避免每次渲染创建新数组，导致依赖 allMessages 的 useMemo 失效
  const allMessages = useMemo(
    () => [...messages, ...streamingMessages],
    [messages, streamingMessages]
  )
  // M1: 跟踪上一轮消息数量，用于检测新消息到达（须在 allMessages 声明之后初始化）
  const prevMessageCountRef = useRef(allMessages.length)

  // I-G-011: 预计算高亮消息 id 集合（O(1) 查找，避免渲染时 includes 遍历）
  const highlightSet = useMemo(
    () => new Set(highlightedMessageIds ?? []),
    [highlightedMessageIds]
  )

  // I-M-011: 预计算用户消息的 id → 索引映射（用于 data-user-index 属性和活跃索引计算）
  // 索引为用户消息在用户消息序列中的序号（0, 1, 2, ...），与进度条圆点一一对应
  const userMessageIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    let userIdx = 0
    for (const msg of allMessages) {
      if (msg.role === 'user') {
        map.set(msg.id, userIdx)
        userIdx++
      }
    }
    return map
  }, [allMessages])

  // 消息数量变化时自动滚动到底部
  // 仅当用户已在底部附近时才自动滚动，避免打断用户阅读历史消息
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
    }
  }, [allMessages.length, isCurrentThreadStreaming])

  // 切换线程时重置滚动 ref 并立即滚动到底部。
  // UI 状态（showScrollToBottom / hasNewMessages）的 setState 已在上方渲染期间完成；
  // ref 变更与 DOM 滚动须在新消息渲染后执行，故仍在 effect 中完成（不触发 setState 规则）。
  useEffect(() => {
    isAtBottomRef.current = true
    // 立即滚动到底部（使用 auto 行为避免动画延迟）
    bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' })
  }, [threadId])

  // I-G-011: 当前匹配项变化时滚动到对应消息（居中显示）
  useEffect(() => {
    if (currentHighlightId) {
      currentHighlightRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }
  }, [currentHighlightId])

  // ---- I-M-011: 计算当前活跃用户消息索引 ----
  // 对齐原型 prototype.html L9640-9666 updateActiveNavDot 算法：
  //   遍历用户消息，取最后一条 offsetTop <= 视口中线的消息作为 active。
  //   （而非"距离中线最近"，两者在消息跨越中线时结果可能不同）
  //   超过 10 条时按比例映射到 10 个圆点（由 VerticalProgressBar 处理映射，
  //   此处仅返回原始用户消息索引）。
  const computeActiveUserMessageIndex = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const userMsgEls = viewport.querySelectorAll<HTMLElement>(
      '[data-user-message="true"]'
    )
    if (userMsgEls.length === 0) {
      onScrollActiveIndexRef.current?.(null)
      return
    }
    // 视口中线（相对滚动内容顶部的 Y 坐标，用 scrollTop + clientHeight/2 计算）
    const midpoint = viewport.scrollTop + viewport.clientHeight / 2
    // viewport 自身在浏览器视口中的矩形：用于把元素的 getBoundingClientRect
    // 转换为相对滚动内容顶部的坐标，避免 offsetTop 依赖 offsetParent 带来的坐标系不一致
    const viewportRect = viewport.getBoundingClientRect()
    // 遍历查找顶部位置 <= midpoint 的最后一条用户消息作为 active
    // （对齐原型：if (userMsgs[i].offsetTop <= midpoint) activeIdx = i; else break;）
    let activeIdx = 0
    for (let i = 0; i < userMsgEls.length; i++) {
      // noUncheckedIndexedAccess 下 userMsgEls[i] 可能为 undefined，需安全访问
      const el = userMsgEls[i]
      if (!el) continue
      // 使用 getBoundingClientRect 确保坐标系一致：
      // offsetTop 相对于 offsetParent（受定位祖先影响，不一定是 viewport），
      // getBoundingClientRect().top 相对浏览器视口；减去 viewportRect.top 再加上
      // scrollTop 后即转换为相对滚动内容顶部的坐标，与 midpoint 处于同一坐标系
      const relativeTop =
        el.getBoundingClientRect().top - viewportRect.top + viewport.scrollTop
      if (relativeTop <= midpoint) {
        activeIdx = i
      } else {
        break
      }
    }
    onScrollActiveIndexRef.current?.(activeIdx)
  }, [])

  // ---- I-M-013: RAF 节流的滚动处理器 ----
  // 使用 ref 读取 viewport（避免 stale closure），保持函数引用稳定。
  // 每帧最多执行一次：已有待执行帧时跳过，帧回调执行后置空 rafId。
  const handleScroll = useCallback(() => {
    if (rafIdRef.current !== null) return
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null
      const viewport = viewportRef.current
      if (!viewport) return
      // 计算距底部的距离（滚动总高度 - 当前滚动位置 - 可视高度）
      const distanceFromBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight
      const atBottom = distanceFromBottom <= SCROLL_TO_BOTTOM_THRESHOLD
      // 同步 ref，供新消息检测读取最新位置（避免 stale closure）
      isAtBottomRef.current = atBottom
      setShowScrollToBottom(!atBottom)
      // M1: 用户手动滚回底部时清除未读红点
      if (atBottom) {
        setHasNewMessages(false)
      }
      // I-M-011: 计算并通知当前活跃用户消息索引
      computeActiveUserMessageIndex()
    })
  }, [computeActiveUserMessageIndex])

  // ---- M1: 监听 ScrollArea viewport 滚动位置 ----
  // 当滚动位置距底部超过阈值时显示"滚动到底部"按钮
  // I-M-013: 使用 RAF 节流的 handleScroll
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return
    // Radix ScrollArea 的 viewport 元素（真正发生滚动的容器）
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) return
    // 缓存 viewport 引用供 RAF 回调读取
    viewportRef.current = viewport

    // 初始检查一次（避免初始位置不在底部时不显示按钮）
    handleScroll()
    viewport.addEventListener('scroll', handleScroll, { passive: true })
    return () => {
      viewport.removeEventListener('scroll', handleScroll)
      viewportRef.current = null
    }
  }, [allMessages.length, isCurrentThreadStreaming, handleScroll])

  // I-M-013: 组件卸载时取消未完成的 RAF，防止内存泄漏
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [])

  // I-M-010: 注册滚动到指定消息的函数（供进度条圆点点击调用）
  // 父组件通过 scrollToMessageRef 持有此函数引用，圆点点击时调用 ref.current(messageId)。
  // 使用 useImperativeHandle 替代手动 ref.current 赋值，符合 React Compiler 规范
  // （react-compiler 规则禁止在 effect 中直接变更 ref.current）。
  // 使用遍历查找而非 CSS 选择器，避免消息 id 含特殊字符时的选择器注入风险。
  useImperativeHandle(
    scrollToMessageRef,
    () => (messageId: string) => {
      const container = scrollContainerRef.current
      if (!container) return
      const els = container.querySelectorAll<HTMLElement>('[data-message-id]')
      for (const el of els) {
        if (el.getAttribute('data-message-id') === messageId) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
          break
        }
      }
    },
    []
  )

  // M1: 检测新消息到达 — 若用户不在底部（已向上滚动），则标记有未读新消息（显示红点）
  // 对齐原型 .scroll-to-bottom.has-new 的语义：仅在有新消息且用户未在底部时才显示红点
  useEffect(() => {
    const prevCount = prevMessageCountRef.current
    if (allMessages.length > prevCount && !isAtBottomRef.current) {
      setHasNewMessages(true)
    }
    prevMessageCountRef.current = allMessages.length
  }, [allMessages.length])

  // ---- M1: 点击"滚动到底部"按钮平滑滚动到底部 ----
  const handleScrollToBottom = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    const viewport = container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-viewport"]'
    )
    if (!viewport) return
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' })
    // 滚动后隐藏按钮（动画结束后用户已在底部）
    setShowScrollToBottom(false)
    // M1: 清除未读新消息红点
    setHasNewMessages(false)
  }, [])

  // 空状态：无消息且无流式输出时显示占位
  if (allMessages.length === 0 && !isLoading) {
    return (
      <div className={cn('flex flex-1 items-center justify-center', className)}>
        <p className="text-sm text-[var(--text-faint)]">开始一段新对话</p>
      </div>
    )
  }

  return (
    // M1: 外层 relative 容器用于定位"滚动到底部"按钮
    // aria-live + aria-atomic="false" + aria-relevant="additions text"：
    //   让屏幕阅读器在流式消息新增/更新时温和通知，但不打断用户当前操作。
    //   - aria-live：流式输出时设为 "off"（避免高频 token 更新过载屏幕阅读器），
    //     非流式时设为 "polite"（等当前朗读完成后再播报新消息，不覆盖用户操作反馈）
    //   - aria-atomic="false"：仅朗读新增/变更的节点，而非整列表
    //   - aria-relevant="additions text"：仅在新增节点或文本变化时通知（忽略删除）
    <div
      ref={scrollContainerRef}
      data-area="messages"
      aria-live={isCurrentThreadStreaming ? 'off' : 'polite'}
      aria-atomic="false"
      aria-relevant="additions text"
      className={cn('relative flex-1 min-h-0', className)}
    >
      <ScrollArea className="h-full">
        {/* M-A-006: 600px 断点下 padding 响应式缩小（messages 16px 0 + inner 0 12px → px-3 py-4） */}
        <div className="mx-auto flex max-w-[820px] flex-col gap-[18px] px-6 py-6 max-[600px]:px-3 max-[600px]:py-4">
          {/* 消息列表 */}
          {allMessages.map((message, index) => {
            // 判断是否为连续的 assistant 消息（前一条也是 assistant text）
            // 连续时隐藏重复头像和角色标签（参考 prototype 的合并逻辑）
            // noUncheckedIndexedAccess 下 allMessages[index-1] 可能是 undefined
            const prevMessage = index > 0 ? allMessages[index - 1] : undefined
            const isContinuation =
              prevMessage !== undefined &&
              prevMessage.role === 'assistant' &&
              (prevMessage.content === 'text' ||
                prevMessage.content === 'reasoning') &&
              message.role === 'assistant' &&
              (message.content === 'text' || message.content === 'reasoning')

            // I-G-011: 搜索高亮状态计算
            const isHighlighted = highlightSet.has(message.id)
            const isCurrentHighlight = currentHighlightId === message.id

            // I-M-011: 用户消息索引（用于进度条 active 状态）
            const userMsgIndex =
              message.role === 'user'
                ? userMessageIndexMap.get(message.id)
                : undefined

            return (
              // I-G-011 + I-M-010 + I-M-011: 包裹 div 用于搜索高亮 ring 样式和消息定位
              <div
                key={message.id}
                data-message-id={message.id}
                data-user-message={
                  message.role === 'user' ? 'true' : undefined
                }
                data-user-index={
                  userMsgIndex !== undefined ? String(userMsgIndex) : undefined
                }
                // I-G-011: 当前匹配项的元素引用（用于 scrollIntoView 居中显示）
                ref={isCurrentHighlight ? currentHighlightRef : undefined}
                className={cn(
                  // ring 使用 box-shadow 实现，不影响布局
                  'rounded-md transition-shadow',
                  isCurrentHighlight && 'ring-2 ring-[var(--accent)]',
                  isHighlighted &&
                    !isCurrentHighlight &&
                    'ring-1 ring-[var(--accent)]/40'
                )}
              >
                <MessageBubble
                  message={message}
                  isContinuation={isContinuation}
                  modelName={modelName}
                  onApprovalAction={onApprovalAction}
                  // P0-3: 直接传递 onRegenerate（签名已改为 (messageId) => void），
                  // 由 MessageBubble 内部绑定 message.id，避免内联箭头破坏 memo
                  onRegenerate={onRegenerate}
                />
              </div>
            )
          })}

          {/* 流式输出时的 typing 指示器（仅在尚无流式文本时显示） */}
          {isCurrentThreadStreaming && streamingMessages.length === 0 && (
            <div className="flex gap-3.5">
              <div className="flex size-[26px] flex-shrink-0 items-center justify-center rounded-[7px] mt-0.5 bg-gradient-to-br from-[var(--accent)] to-[var(--accent-dim)] text-[#001814] font-mono text-xs font-bold shadow-[0_0_14px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.3)]">
                C
              </div>
              <div className="flex items-center pt-2">
                <TypingIndicator />
              </div>
            </div>
          )}

          {/* 加载占位 */}
          {isLoading && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-[var(--text-faint)]">
              <span className="size-1.5 animate-pulse rounded-full bg-[var(--text-faint)]" />
              加载中...
            </div>
          )}

          {/* 底部锚点（用于自动滚动定位） */}
          <div ref={bottomRef} className="h-px" />
        </div>
      </ScrollArea>

      {/* M1: 滚动到底部按钮（对齐原型 .scroll-to-bottom）
          样式：36px 圆形按钮，absolute 定位于紧贴输入框上方水平居中
          显示条件：滚动位置距底部超过阈值 */}
      {showScrollToBottom && (
        <button
          type="button"
          onClick={handleScrollToBottom}
          aria-label="滚动到底部"
          title="滚动到底部"
          className={cn(
            // 定位：absolute，紧贴输入框上方（bottom-3 = 12px），水平居中
            // 原型用 bottom:140px，但当前 ChatInput 高度与原型 composer 不同，
            // 用户反馈按钮应紧贴输入框上方，改为 bottom-3（12px）
            // P0 修复：z-[1100] → z-[var(--z-sticky)]（对齐原型 z-index:var(--z-sticky,1100)）
            'absolute bottom-3 left-1/2 z-[var(--z-sticky)] -translate-x-1/2',
            // 尺寸与形状：36px 圆形（对齐 .scroll-to-bottom { width:36px; height:36px; border-radius:50% }）
            'flex size-9 items-center justify-center rounded-full',
            // 颜色：bg-elev-2 背景 + border 边框 + text-dim 图标
            'border border-[var(--border)] bg-[var(--bg-elev-2)] text-[var(--text-dim)]',
            // P0 修复：补 cursor-pointer + touch-manipulation（对齐原型 cursor:pointer + touch-action:manipulation）
            'cursor-pointer touch-manipulation',
            // 阴影 + hover 效果
            // P0 修复：transition-colors → transition-[background-color,color] duration-150（对齐原型 transition:background-color,color 0.15s）
            'shadow-[0_2px_12px_rgba(0,0,0,0.3)] transition-[background-color,color] duration-150',
            'hover:bg-[var(--bg-elev)] hover:text-[var(--accent)]'
          )}
        >
          {/* 下箭头图标（对齐原型 svg polyline 6 9 12 15 18 9） */}
          {/* P0 修复：stroke-width 2 → 2.5（对齐原型 SVG stroke-width="2.5"） */}
          <ChevronDown className="size-4" strokeWidth={2.5} />
          {/* M1: 新消息红点（对齐 .new-msg-dot / .has-new）— 仅在脱离底部且有未读新消息时显示 */}
          {hasNewMessages && (
            <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-[var(--accent)]" />
          )}
        </button>
      )}
    </div>
  )
}
