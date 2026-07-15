/**
 * ConversationArea — 对话区主容器
 *
 * 对应 prototype.html 的 `.messages` + `.composer` 整体布局。
 *
 * 功能职责：
 * 1. 无活跃 thread 时显示欢迎屏（welcome screen）
 * 2. 有活跃 thread 时渲染消息列表 + 输入框 + 垂直进度条
 * 3. 通过 TanStack Query 自动加载消息（useMessages hook）
 * 4. 监听 `codex:notification` Tauri 事件，分流到 streaming-store + invalidate
 *
 * 状态来源：
 * - thread-store：活跃 thread ID（纯 UI 状态）
 * - queries/threads：线程列表（从中查找活跃 thread 的元信息）
 * - queries/messages：消息列表（服务端数据，TanStack Query 管理）
 * - conversation-store：活跃轮次、轮次历史、发送状态（纯 UI 状态）
 * - streaming-store：流式消息缓冲区（临时增量数据，delta 累积）
 * - draft-store：输入框草稿（在 ChatInput 内部处理）
 *
 * 事件驱动更新（streaming-store + TanStack Query 协作）：
 *   收到 codex:notification 事件后根据通知类型分流：
 *   - turn/started → startStreaming(threadId) 进入流式模式
 *   - item/started → 忽略（流式 delta 会增量更新，无需全量刷新）
 *   - item/agentMessage/delta → appendDelta(chunk) 增量更新流式预览
 *   - item/reasoning/*Delta → appendDelta(chunk) 增量更新推理内容
 *   - item/plan/delta → appendDelta(chunk) 增量更新计划文本
 *   - item/completed → 逐 item 归档管道：
 *       resolveStreamingItem(itemId) → setQueryData 乐观更新 → invalidate 后台刷新
 *   - turn/completed → stopStreaming + clearStreaming 清理残留 + invalidate 全量刷新
 *   - 其他 → invalidate 全量刷新
 */

import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useThreadStore } from '@/store/thread-store'
import { useThreads, useCreateThread } from '@/queries/threads'
import {
  useMessages,
  useStartTurn,
  useCancelTurn,
  invalidateMessages,
  messagesQueryKeys,
} from '@/queries/messages'
import { useStreamingStore } from '@/store/streaming-store'
import { useDraftStore } from '@/store/draft-store'
import {
  useConversationStore,
  type ConversationStoreState,
} from './conversation-store'
import { MessageList } from './MessageList'
import { ChatInput } from './ChatInput'
import { VerticalProgressBar } from './VerticalProgressBar'
// UX 组件 — 对齐 HTML 原型的状态横幅与快捷入口
import { NetStatusBanner } from './NetStatusBanner'
import { RateLimitBanner } from './RateLimitBanner'
import { ConversationSearchBar } from './ConversationSearchBar'
import { WelcomeQuickActions } from './WelcomeQuickActions'
import { logger } from '@/lib/logger'
// 统一事件监听：Tauri 用原生 listen，浏览器用 mockEventBus
import { universalListen } from '@/lib/codex/mock'
// 审批 API — 提交审批响应（批准/拒绝）到后端
import { submitApproval } from '@/lib/codex/approval'
// 审批 store — Demo 面板注入审批卡片时通过此 store 触发弹窗
import { useApprovalStore } from '@/store/approval-store'
// 内联审批卡片 — 当有 pendingApproval 时在对话流中内联渲染（对齐原型 .card.paused）
import { ApprovalDialog } from '@/features/approval'
// Demo 注入事件类型 — 用于监听 codex:demo-inject 自定义事件
import type {
  DemoInjectEvent,
  DemoMessageType,
  DemoCardType,
} from '@/features/demo/demo-injector'
import type {
  ThreadId,
  Thread,
  Turn,
  Message,
  PlanItem,
  PlanItemStatus,
  ToolCall,
  FileChange,
  DiffLine,
} from '@/lib/codex/types'
import {
  parseNotification,
  getNotificationThreadId,
  notificationToStreamingChunk,
  isCompletionNotification,
  isTurnStartNotification,
  isItemCompletedNotification,
  isItemStartedNotification,
  getItemIdFromLifecycleNotification,
} from '@/lib/codex/notifications'

// ─── 稳定的空数组常量 ──────────────────────────────────────────
// 避免在 Zustand selector 中每次返回新的 [] 引用，导致无限重渲染。
const EMPTY_TURNS: Turn[] = []
// useThreads 初次加载 data 为 undefined 时的稳定回退值
const EMPTY_THREADS: Thread[] = []
// useMessages 加载期间 data 为 undefined 时的稳定回退值，
// 避免每次渲染创建新数组引用触发下游 useMemo 重算
const EMPTY_MESSAGES: Message[] = []

/**
 * 欢迎页虚拟 threadId — 用于 ChatInput 草稿管理。
 *
 * 欢迎页无活跃 thread，但 ChatInput 需要 threadId 来管理草稿。
 * 使用此虚拟 ID 隔离欢迎页草稿，发送后自动清除。
 */
const WELCOME_THREAD_ID = '__welcome__' as ThreadId

export function ConversationArea() {
  const queryClient = useQueryClient()

  // ---- 从 thread-store 获取活跃 thread ID（纯 UI 状态）----
  const activeThreadId = useThreadStore(s => s.activeThreadId)

  // ---- 从 TanStack Query 获取线程列表，查找活跃 thread 元信息 ----
  // useThreads 自动管理缓存，activeThread 从缓存数据中派生
  // 用 useMemo 记忆化 find 结果，避免 query 刷新时连锁触发 MessageList 重渲染
  const { data: threads = EMPTY_THREADS } = useThreads()
  const activeThread = useMemo(
    () => threads.find(t => t.id === activeThreadId) ?? null,
    [threads, activeThreadId]
  )

  // ---- 从 TanStack Query 获取消息列表（服务端数据）----
  // useMessages 自动管理 loading、缓存、重试、stale-while-revalidate
  // data 为 undefined 时回退到模块级常量 EMPTY_MESSAGES，保持引用稳定
  const { data: messages = EMPTY_MESSAGES, isLoading } = useMessages(activeThreadId)

  // ---- 从 conversation-store 获取纯 UI 状态 ----
  // 活跃轮次、轮次历史、发送状态（这些是会话级 UI 状态，不属于服务端持久化数据）
  const activeTurn = useConversationStore(
    (s: ConversationStoreState) =>
      s.activeTurnByThread[activeThreadId ?? ''] ?? null
  )
  const turns = useConversationStore(
    (s: ConversationStoreState) =>
      s.turnsByThread[activeThreadId ?? ''] ?? EMPTY_TURNS
  )
  const isSending = useConversationStore(
    (s: ConversationStoreState) =>
      s.sendingByThread[activeThreadId ?? ''] ?? false
  )
  const setActiveTurn = useConversationStore(s => s.setActiveTurn)
  const setSending = useConversationStore(s => s.setSending)
  const appendTurnHistory = useConversationStore(s => s.appendTurnHistory)

  // ---- 突变钩子（TanStack Query）----
  const startTurnMutation = useStartTurn()
  const cancelTurnMutation = useCancelTurn()
  const createThreadMutation = useCreateThread()

  // ---- streaming-store actions ----
  // 用于流式 delta 累积和生命周期管理
  const startStreaming = useStreamingStore(s => s.startStreaming)
  const appendDelta = useStreamingStore(s => s.appendDelta)
  const stopStreaming = useStreamingStore(s => s.stopStreaming)
  const resolveStreamingItem = useStreamingStore(s => s.resolveStreamingItem)
  const clearStreaming = useStreamingStore(s => s.clearStreaming)

  // ---- 对话内搜索栏可见性 ----
  // 由 Ctrl/Cmd+F 快捷键切换
  const [searchVisible, setSearchVisible] = useState(false)

  // ---- I-G-011: 对话内搜索状态 ----
  // searchQuery: 搜索查询文本（受控，传给 ConversationSearchBar）
  // searchResults: 匹配的消息索引数组（messages 数组中的下标）
  // currentMatchIdx: 当前定位到的匹配项在 searchResults 中的索引
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<number[]>([])
  const [currentMatchIdx, setCurrentMatchIdx] = useState(0)

  // ---- I-M-011: 活跃用户消息索引（进度条滚动联动） ----
  // 由 MessageList 滚动时计算并通知，传给 VerticalProgressBar 高亮对应圆点
  const [activeMessageIndex, setActiveMessageIndex] = useState<number | null>(null)

  // ---- I-M-010: 滚动到指定消息的函数引用 ----
  // MessageList 注册滚动函数到此 ref，进度条圆点点击时调用
  const scrollToMessageRef = useRef<((messageId: string) => void) | null>(null)

  // ---- I-G-011: 关闭搜索栏并清除搜索状态 ----
  // 在事件处理器中调用（而非 effect），避免 react-hooks/set-state-in-effect 警告。
  // 所有关闭搜索栏的入口（onClose 回调、Ctrl+F 切换关闭、Escape 键）都通过此函数统一处理，
  // 确保隐藏搜索栏时同步清除高亮、匹配结果、查询文本。
  const closeSearch = useCallback(() => {
    setSearchVisible(false)
    setSearchQuery('')
    setSearchResults([])
    setCurrentMatchIdx(0)
  }, [])

  // ---- 草稿 store（用于 Welcome 快捷入口填入 prompt）----
  const setDraft = useDraftStore(s => s.setDraft)
  // ---- thread-store 操作（用于 Welcome 快捷入口创建新会话）----
  const setActiveThread = useThreadStore(s => s.setActiveThread)
  // P1-6: 读取待创建会话的文件夹（点击「新建会话」时记录的当前会话 folder）
  const pendingFolder = useThreadStore(s => s.pendingFolder)
  const setPendingFolder = useThreadStore(s => s.setPendingFolder)

  // ---- 监听 codex:notification 事件 ----
  // 事件分流策略（streaming-store + TanStack Query 协作）：
  // 1. turn/started → startStreaming 进入流式模式
  // 2. item/started → 忽略（流式 delta 会增量更新，无需全量刷新）
  // 3. delta 类（agentMessage/delta, reasoning/*Delta, plan/delta）→ appendDelta 增量更新
  // 4. item/completed → 逐 item 归档管道：
  //    resolveStreamingItem → setQueryData 乐观更新 → invalidate 后台刷新
  // 5. turn/completed → stopStreaming + clearStreaming 清理残留 + invalidate 全量刷新
  // 6. 其他 → invalidate 全量刷新
  // 这样流式过程中用户看到逐字输出（streaming-store），item 完成时立即归档到
  // TanStack Query 缓存（乐观更新消除空白闪烁），后台 invalidate 保证最终一致性。
  //
  // ── Bug 4（P2）修复说明 ──────────────────────────────────────────
  // 修复前：本 effect 依赖 activeThreadId，每次切换 thread 都会先卸载旧监听器
  //   （同步），再注册新监听器（异步 universalListen().then）。在 Promise resolve
  //   之前的间隙内到达的事件会丢失（无监听器在位）。
  // 修复后：拆为三个 effect——
  //   ① handlerRef effect：依赖 activeThreadId，仅更新事件处理函数（同步）
  //   ② 主监听 effect：空依赖，组件挂载时注册一次监听器，调用 handlerRef.current
  //   ③ 清理 effect：依赖 activeThreadId，切换 thread 时清理上一个 thread 的流式缓冲
  // 这样监听器始终在位，事件不再丢失；handler 通过 ref 始终指向最新版本。
  const notificationHandlerRef = useRef<(payload: unknown) => void>(() => undefined)

  // ① 更新事件处理函数（不重新注册监听器）
  useEffect(() => {
    if (activeThreadId === null) {
      // 无活跃 thread：handler 置为 noop，监听器仍保留在位
      notificationHandlerRef.current = () => undefined
      return
    }
    // 闭包捕获当前 activeThreadId，确保事件分流操作针对正确的 thread
    notificationHandlerRef.current = (payload: unknown) => {
      // 解析后端 ServerNotification payload
      const notif = parseNotification(payload)
      const notifThreadId = getNotificationThreadId(notif)

      // 仅处理与当前活跃 thread 相关的通知
      if (notifThreadId !== activeThreadId) return

      // ---- 事件分流 ----

      // 1. 轮次开始 → 进入流式模式
      if (isTurnStartNotification(notif)) {
        startStreaming(activeThreadId)
        logger.debug('Streaming started', {
          threadId: activeThreadId,
        })
        return
      }

      // 2. 条目开始 → 忽略（流式 delta 会增量更新，无需全量刷新）
      if (isItemStartedNotification(notif)) {
        return
      }

      // 3. delta 类 → 增量更新 streaming-store
      const chunk = notificationToStreamingChunk(notif)
      if (chunk !== null) {
        appendDelta(chunk)
        return
      }

      // 4. 单个条目完成 → 逐 item 归档管道（乐观更新）
      if (isItemCompletedNotification(notif)) {
        const itemId = getItemIdFromLifecycleNotification(notif)
        if (itemId) {
          // 4a. 将流式内容转为最终 Message 并从缓冲区移除
          const message = resolveStreamingItem(itemId)
          if (message) {
            // 4b. 乐观插入到 TanStack Query 缓存（立即显示最终消息，消除空白闪烁）
            queryClient.setQueryData<Message[]>(
              messagesQueryKeys.byThread(activeThreadId),
              (oldMessages) => {
                const existing = oldMessages ?? []
                // 避免重复插入（invalidate 返回的数据可能已包含该 item）
                if (existing.some(m => m.id === message.id)) {
                  return existing
                }
                return [...existing, message]
              }
            )
          }
        }
        // 4c. 不在此处 invalidate —— item/completed 可能高频触发（一个 turn 数十到上百次），
        // 每次 invalidate 都会引发一次 listMessages IPC 调用，造成 IPC 风暴。
        // setQueryData 乐观插入已保证 UI 即时更新（含 id 去重），
        // 最终一致性由下方 turn/completed 分支的 invalidate 兜底。
        logger.debug('Item completed, archived to query cache', {
          threadId: activeThreadId,
          itemId,
        })
        return
      }

      // 5. 轮次完成 → 停止流式 + 清理残留 + 全量刷新
      if (isCompletionNotification(notif)) {
        stopStreaming(activeThreadId)
        clearStreaming(activeThreadId)
        invalidateMessages(queryClient, activeThreadId)
        logger.debug('Turn completed, streaming cleared and cache invalidated', {
          threadId: activeThreadId,
          method: notif.method,
        })
        return
      }

      // 6. 其他通知 → 失效缓存全量刷新
      invalidateMessages(queryClient, activeThreadId)
    }
  }, [
    activeThreadId,
    queryClient,
    startStreaming,
    appendDelta,
    stopStreaming,
    resolveStreamingItem,
    clearStreaming,
  ])

  // ② 主监听 effect：空依赖，组件挂载时注册一次，卸载时释放
  useEffect(() => {
    let isMounted = true
    let unlisten: UnlistenFn | null = null

    // 统一事件监听：Tauri 环境用原生事件，浏览器环境用 mockEventBus（流式模拟）
    // 注意：handler 通过 ref 间接调用，保证始终指向最新版本（依赖 ① effect 同步）
    universalListen<unknown>('codex:notification', payload => {
      notificationHandlerRef.current(payload)
    })
      .then(unlistenFn => {
        if (!isMounted) {
          // 组件已卸载：立即释放监听器，避免泄漏
          unlistenFn()
        } else {
          unlisten = unlistenFn
        }
      })
      .catch(error => {
        logger.error('注册 codex:notification 监听器失败', { error })
      })

    return () => {
      isMounted = false
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  // ③ 切换 thread 时清理上一个 thread 的流式缓冲残留（独立 effect，避免污染主监听 effect）
  // 不清理的话，用户切回该 thread 时会渲染过时的 streamingItems，
  // 与已拉取的完整消息列表重复显示（id 不同：itemId vs streaming-{itemId}）。
  const prevThreadIdRef = useRef<ThreadId | null>(null)
  useEffect(() => {
    const prev = prevThreadIdRef.current
    if (prev !== null && prev !== activeThreadId) {
      // 切换 thread：清理上一个 thread 的流式缓冲残留
      stopStreaming(prev)
      clearStreaming(prev)
    }
    prevThreadIdRef.current = activeThreadId

    return () => {
      // cleanup 在切换或卸载时触发：
      //   - 切换：闭包 activeThreadId 是上一个值，会被上面 if 分支清理，这里也清理一次（幂等）
      //   - 卸载：清理当前 thread 的流式缓冲
      if (activeThreadId !== null) {
        stopStreaming(activeThreadId)
        clearStreaming(activeThreadId)
      }
    }
  }, [activeThreadId, stopStreaming, clearStreaming])

  // ---- 监听 Demo 面板注入事件（仅开发模式生效）----
  // DemoPanel 通过 window.dispatchEvent 派发 codex:demo-inject 自定义事件，
  // 本组件监听后根据 payload kind 分流：
  //   - 'approval' → 构造 PendingApproval 推入 approval-store，触发审批弹窗
  //   - 'message' → 根据 messageType 构造 mock Message 并插入到消息列表缓存
  //     · 'rate' 类型特殊处理：派发 'codex:rate-limit' 事件触发 RateLimitBanner
  //   - 'card' → 根据 cardType 构造 mock 工具卡片 Message 并插入到消息列表缓存
  //   - 'comprehensive' → toast 提示（综合演示由 demo-injector 串行派发多个事件）
  // 设计说明（低耦合）：
  //   DemoPanel 不直接操作 store，而是通过事件总线解耦；
  //   本组件仅负责"接收事件并路由到对应 store/UI"。
  // 依赖说明：
  //   依赖 activeThreadId 和 queryClient，当 activeThreadId 变化时重新注册监听器，
  //   确保 demo 消息插入到当前活跃 thread 的缓存。
  useEffect(() => {
    // 生产模式下不监听（DemoPanel 在生产模式返回 null，不会派发事件）
    if (!import.meta.env.DEV) return

    const handleDemoInject = (e: Event) => {
      const detail = (e as CustomEvent<DemoInjectEvent>).detail
      if (!detail) return

      logger.debug('Demo inject received', { kind: detail.kind, detail })

      switch (detail.kind) {
        case 'approval': {
          // 构造 mock 审批请求并推入 approval-store，触发 ApprovalDialog
          // 注意：ApprovalVariant 有 7 种，但 ApprovalType 只有 4 种，
          // 需通过 mapDemoVariantToApprovalType 映射（tool/mcp/dyn/attest 归入 command）
          const variant = detail.approvalVariant ?? 'command'
          const approvalStore = useApprovalStore.getState()
          approvalStore.setPendingApproval({
            id: `demo-${variant}-${Date.now()}`,
            requestIdDisplay: `demo-${variant}`,
            type: mapDemoVariantToApprovalType(variant),
            payload: getDemoApprovalPayload(variant),
            status: 'pending',
          })
          break
        }

        case 'message': {
          // A1: 将 Demo 消息路由到实际渲染（不再仅 toast 提示）
          const msgType = detail.messageType
          if (!msgType) {
            toast.warning('演示消息缺少 messageType 字段')
            return
          }

          // 'rate' 类型特殊处理：派发 'codex:rate-limit' 事件触发 RateLimitBanner
          // 对齐原型 showRateBanner() 的行为（2h 34m 12s = 9252 秒）
          if (msgType === 'rate') {
            const resetSeconds = 2 * 3600 + 34 * 60 + 12
            window.dispatchEvent(
              new CustomEvent('codex:rate-limit', {
                detail: { resetSeconds },
              })
            )
            toast.info('已显示 Rate Limit 横幅')
            return
          }

          // 其他类型：需要活跃 thread 才能插入消息
          if (activeThreadId === null) {
            toast.warning('请先创建或选择一个会话再注入演示消息')
            return
          }

          // 构造 mock Message（rate 类型返回 null，已在上方处理）
          const demoMessage = createDemoMessage(msgType, detail.mockData)
          if (demoMessage === null) {
            // 理论上不会走到此处（rate 已在上方提前 return），但类型系统需要此检查
            return
          }

          // 通过 setQueryData 将 mock 消息追加到当前 thread 的消息列表末尾
          queryClient.setQueryData<Message[]>(
            messagesQueryKeys.byThread(activeThreadId),
            (oldMessages) => {
              const existing = oldMessages ?? []
              return [...existing, demoMessage]
            }
          )
          toast.info('演示消息已注入', {
            description: `类型: ${msgType}`,
          })
          break
        }

        case 'card': {
          // A1: 将 Demo 卡片路由到实际渲染（不再仅 toast 提示）
          const cardType = detail.cardType
          if (!cardType) {
            toast.warning('演示卡片缺少 cardType 字段')
            return
          }

          // 需要活跃 thread 才能插入消息
          if (activeThreadId === null) {
            toast.warning('请先创建或选择一个会话再注入演示卡片')
            return
          }

          // 构造 mock 工具卡片 Message
          const demoCardMessage = createDemoCardMessage(cardType, detail.mockData)
          queryClient.setQueryData<Message[]>(
            messagesQueryKeys.byThread(activeThreadId),
            (oldMessages) => {
              const existing = oldMessages ?? []
              return [...existing, demoCardMessage]
            }
          )
          toast.info('演示卡片已注入', {
            description: `类型: ${cardType}`,
          })
          break
        }

        case 'comprehensive': {
          // 综合演示由 demo-injector.ts 的 handleDemoComprehensive 串行派发多个事件，
          // 此处仅给出提示，实际消息/卡片由上述 'message'/'card' 分支逐条插入。
          toast.info('综合演示已启动', {
            description: '请观察对话流变化',
          })
          break
        }
      }
    }

    window.addEventListener('codex:demo-inject', handleDemoInject as EventListener)
    return () => {
      window.removeEventListener(
        'codex:demo-inject',
        handleDemoInject as EventListener
      )
    }
  }, [activeThreadId, queryClient])

  // ---- messages ref（用于稳定 handleRegenerate 引用）----
  // 修复 Bug 2（P1）：handleRegenerate 原依赖 messages，每次消息缓存更新都会重建回调，
  // 导致传入 MessageList 后所有 MessageBubble 的 React.memo 失效（props 引用变化）。
  // 通过 ref 同步最新 messages，使 handleRegenerate 依赖数组中不再包含 messages，
  // 回调引用稳定，下游 memo 才能生效。
  //
  // 注意：React 19 严格模式下禁止在 render 阶段更新 ref（react-hooks/refs 规则），
  // 改为在 useEffect 中同步。由于 handleRegenerate 是用户点击触发的事件处理器，
  // 调用时 effect 必然已执行完毕，messagesRef.current 一定是最新的 messages。
  const messagesRef = useRef(messages)
  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  // ---- 发送消息回调 ----
  // 使用 useStartTurn 突变钩子，内部已处理缓存失效和错误提示
  //
  // 修复 Bug 3（P1）：原版未做乐观更新，需等待 mutateAsync resolve 后由 onSuccess
  // invalidate 触发重新拉取，用户才会看到自己的消息——存在数百毫秒感知延迟。
  // 现在发送前先把用户消息以临时 ID 插入到 TanStack Query 缓存（乐观更新），
  // 后端成功后由 invalidate 拉取的真实消息替换；失败则在 catch 中移除乐观消息。
  // 注意：useStartTurn 的 onError 已通过 toast 提示错误，此处不再重复 toast。
  const handleSend = useCallback(
    async (text: string) => {
      if (activeThreadId === null) return

      // 乐观更新：立即将用户消息插入缓存，消除用户感知延迟。
      // 临时 ID 使用 optimistic- 前缀，避免与后端真实消息 ID 冲突；
      // 后端保存后由 invalidateMessages 触发重新拉取，真实消息会替换此乐观消息
      // （即使后端消息 id 不同也无妨，乐观消息会被自然取代）。
      const optimisticId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const optimisticMessage: Message = {
        id: optimisticId,
        role: 'user',
        content: 'text',
        text,
        timestamp: Date.now(),
      }
      queryClient.setQueryData<Message[]>(
        messagesQueryKeys.byThread(activeThreadId),
        (oldMessages) => {
          const existing = oldMessages ?? []
          return [...existing, optimisticMessage]
        }
      )

      // 设置发送中状态（UI 反馈：禁用输入框）
      setSending(activeThreadId, true)
      try {
        const turn = await startTurnMutation.mutateAsync({
          threadId: activeThreadId,
          message: text,
        })
        // 设置活跃轮次（UI 反馈：显示中断按钮、进度条）
        setActiveTurn(activeThreadId, turn)
      } catch {
        // 发送失败：移除乐观消息，避免 UI 残留无效的用户消息
        queryClient.setQueryData<Message[]>(
          messagesQueryKeys.byThread(activeThreadId),
          (oldMessages) => {
            const existing = oldMessages ?? []
            return existing.filter(m => m.id !== optimisticId)
          }
        )
      } finally {
        setSending(activeThreadId, false)
      }
    },
    [activeThreadId, queryClient, startTurnMutation, setSending, setActiveTurn]
  )

  // ---- A2: 重新生成回调 ----
  // 当用户点击某条消息的"重新生成"按钮时触发。
  // 逻辑：
  //   1. 在 messages 数组中找到被点击消息的位置
  //   2. 从该位置往前查找最近的 user 消息（含非空 text）
  //   3. 调用 handleSend 重新发送该用户消息文本
  // 如果找不到对应的用户消息（如点击的是系统消息或无前序用户消息），
  // 则 toast 提示用户无法重新生成。
  //
  // Bug 6（P3）说明：本函数名为"重新生成"但实际语义是"追加重发"——
  // 不会移除原有助手回复，而是在消息列表末尾追加新一轮回复。
  // 若产品需求改为"替换原回复"，需在此处先删除 messageId 之后的全部消息
  // 再调用 handleSend。当前为追加重发行为，符合最小副作用原则。
  //
  // Bug 2（P1）修复：使用 messagesRef.current 读取最新 messages，
  // 避免将 messages 放入依赖数组导致每次消息缓存更新都重建本回调
  // （重建会让下游 MessageBubble 的 React.memo 全部失效）。
  const handleRegenerate = useCallback(
    (messageId: string) => {
      // 通过 ref 读取最新 messages，使本回调依赖数组稳定
      const msgs = messagesRef.current
      // 找到被点击消息在 messages 数组中的索引
      const clickedIdx = msgs.findIndex(m => m.id === messageId)
      if (clickedIdx === -1) {
        toast.warning('未找到对应消息')
        return
      }

      // 从被点击位置往前查找最近的 user 消息（含非空 text）
      let userText: string | null = null
      for (let i = clickedIdx; i >= 0; i--) {
        const msg = msgs[i]
        if (msg !== undefined && msg.role === 'user' && msg.text.trim() !== '') {
          userText = msg.text
          break
        }
      }

      if (userText === null) {
        toast.warning('未找到可重新发送的用户消息')
        return
      }

      // 调用 handleSend 重新发送（handleSend 内部已处理 sending 状态和错误提示）
      void handleSend(userText)
    },
    [handleSend]
  )

  // ---- 中断轮次回调 ----
  // 使用 useCancelTurn 突变钩子，内部已处理缓存失效和错误提示
  const handleCancel = useCallback(async () => {
    if (activeThreadId === null) return
    const turn = activeTurn
    if (turn === null) return

    // 先更新 UI 状态：清除活跃轮次，追加到历史
    const finalTurn: Turn = {
      ...turn,
      status: 'cancelled',
      completedAt: Date.now(),
    }
    setActiveTurn(activeThreadId, null)
    appendTurnHistory(activeThreadId, finalTurn)

    // 调用后端中断（失败时 toast 提示，不回滚 UI 状态——用户已看到取消效果）
    await cancelTurnMutation.mutateAsync({
      threadId: activeThreadId,
      turnId: turn.id,
    })
  }, [
    activeThreadId,
    activeTurn,
    cancelTurnMutation,
    setActiveTurn,
    appendTurnHistory,
  ])

  // ---- Ctrl/Cmd+F 打开对话内搜索栏 ----
  // 对齐原型 prototype.html L17473-17482：
  //   - "只打开"语义（不 toggle），已打开时重复按 Ctrl+F 不关闭
  //   - 仅当当前聚焦元素不是输入框（或已是对话搜索输入框自身）时才触发
  //     避免与 use-keyboard-shortcuts.ts 的 ⌘F 文件模糊搜索冲突：
  //     - composer 输入框聚焦 → 文件模糊搜索（use-keyboard-shortcuts 处理）
  //     - 其他位置聚焦 → 对话内搜索（此处处理）
  //   - Shift+Ctrl+F 不触发（留给未来其他快捷键）
  // 关闭搜索栏时通过 closeSearch 统一清除搜索状态（避免 effect 内 setState）
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+F (Windows/Linux) 或 Cmd+F (macOS)，排除 Shift 组合
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'f' &&
        !e.shiftKey
      ) {
        // 判断当前聚焦元素：输入框聚焦时交给 use-keyboard-shortcuts 处理文件模糊搜索
        const activeTag = document.activeElement?.tagName ?? ''
        const activeId = document.activeElement?.id ?? ''
        // 对话搜索输入框自身聚焦时允许触发（不重复打开，但也不阻止）
        if (activeTag === 'INPUT' && activeId !== 'conv-search-input') {
          return
        }
        e.preventDefault()
        // "只打开"语义：已打开时不关闭（对齐原型 openConvSearch 行为）
        if (!searchVisible) {
          setSearchVisible(true)
        }
      }
      // Esc 关闭搜索栏（仅当搜索栏可见时）
      if (e.key === 'Escape' && searchVisible) {
        closeSearch()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [searchVisible, closeSearch])

  // ---- Welcome 快捷入口点击回调 ----
  // I-M-009 修复：仅将 prompt 填入欢迎屏输入框草稿，不创建会话。
  // 用户可在输入框编辑内容后发送，发送时走 handleWelcomeSend 流程创建会话。
  // 行为变更：此前点击快捷入口会立即创建新会话，改为仅填入草稿，
  // 让用户有机会编辑内容后再决定发送。
  const handlePickPrompt = useCallback(
    (prompt: string) => {
      setDraft(WELCOME_THREAD_ID, prompt)
    },
    [setDraft]
  )

  // ---- 欢迎页发送消息回调 ----
  // 欢迎页无活跃 thread，发送时先创建 thread 再发送消息。
  // 创建后 setActiveThread，后续发送走正常的 handleSend 流程。
  //
  // P1-6: 文件夹继承 — 对齐原型 L10897-10902
  // 创建会话时读取 pendingFolder（点击「新建会话」时记录的当前会话 folder），
  // 作为新会话的 metadata.folder，使新会话归入同一文件夹。
  // 创建完成后立即清空 pendingFolder，避免污染后续手动创建。
  const handleWelcomeSend = useCallback(
    async (text: string) => {
      // 读取待继承的 folder（null 表示不归属任何文件夹）
      // 注意：folder 在 try 外读取，确保 finally 能访问到当前 pendingFolder 的值
      const folder = pendingFolder
      try {
        const thread = await createThreadMutation.mutateAsync({
          cwd: folder ? `/Users/dev/${folder}` : null,
          metadata: {
            title: text.slice(0, 30) || '新会话',
            ...(folder ? { folder } : {}),
          },
        })
        setActiveThread(thread.id)
        // 设置发送中状态
        setSending(thread.id, true)
        try {
          const turn = await startTurnMutation.mutateAsync({
            threadId: thread.id,
            message: text,
          })
          setActiveTurn(thread.id, turn)
        } finally {
          setSending(thread.id, false)
        }
      } catch (err) {
        toast.error('创建会话失败')
        logger.error('欢迎页发送消息创建会话失败', { error: err })
      } finally {
        // 修复 Bug 1（P0）：setPendingFolder(null) 必须放在 finally 块。
        // 修复前仅写在成功路径，catch 块未清理，导致创建失败后再次点击「新建会话」时
        // 仍会沿用旧的 folder（用户已感知到失败，但 store 中残留脏数据）。
        // 无论创建成功还是失败，pendingFolder 都应被消费掉，避免污染后续手动创建。
        setPendingFolder(null)
      }
    },
    [
      createThreadMutation,
      pendingFolder,
      setPendingFolder,
      setActiveThread,
      setSending,
      startTurnMutation,
      setActiveTurn,
    ]
  )

  // ---- I-G-011: 对话内搜索逻辑 ----
  // 遍历 messages 数组，匹配 message.text 包含 query 的消息索引。
  // 注：Message.text 为消息文本内容字段（用户/助手消息的正文），
  //     非 Message.content（后者为消息类型枚举，如 'text'/'tool_call'）。
  const handleSearch = useCallback(
    (query: string) => {
      setSearchQuery(query)
      const trimmed = query.trim().toLowerCase()
      if (trimmed === '') {
        setSearchResults([])
        setCurrentMatchIdx(0)
        return
      }
      // 遍历消息列表，收集匹配的消息索引
      const results: number[] = []
      messages.forEach((msg, idx) => {
        if (msg.text.toLowerCase().includes(trimmed)) {
          results.push(idx)
        }
      })
      setSearchResults(results)
      // 重置到第一个匹配项
      setCurrentMatchIdx(0)
    },
    [messages]
  )

  // ---- I-G-011: 搜索导航（在匹配项间循环跳转） ----
  // dir=1 下一个，dir=-1 上一个，循环切换
  const handleNavigate = useCallback(
    (dir: 1 | -1) => {
      setCurrentMatchIdx(prev => {
        if (searchResults.length === 0) return 0
        return (prev + dir + searchResults.length) % searchResults.length
      })
    },
    [searchResults.length]
  )

  // ---- I-M-010: 用户消息列表（进度条圆点数据源） ----
  // 从 messages 中提取用户消息，index 为用户消息序号（与进度条圆点一一对应）
  const userMessages = useMemo(
    () =>
      messages
        .filter(m => m.role === 'user')
        .map((m, idx) => ({ id: m.id, index: idx })),
    [messages]
  )

  // ---- I-M-010: 进度条圆点点击 → 滚动到对应用户消息 ----
  // index 为用户消息序号，通过 scrollToMessageRef 调用 MessageList 注册的滚动函数
  const handleDotClick = useCallback(
    (index: number) => {
      const msg = userMessages[index]
      if (msg) {
        scrollToMessageRef.current?.(msg.id)
      }
    },
    [userMessages]
  )

  // ---- I-M-015: 审批操作回调 ----
  // 内联审批卡片点击审批/拒绝/白名单时的处理。
  // 传给 MessageList → MessageBubble → InlineApprovalCard。
  // 调用后端 approval API（submitApproval）提交审批响应：
  //   - approve  → submitApproval({ approved: true })
  //   - reject   → submitApproval({ approved: false, reason })
  //   - whitelist → 视为批准（approved: true），白名单规则由后端处理
  const handleApprovalAction = useCallback(
    async (requestId: string, action: 'approve' | 'reject' | 'whitelist') => {
      // whitelist 在 API 层面等同于批准，后端可根据白名单规则后续不再询问同类请求
      const approved = action === 'approve' || action === 'whitelist'
      try {
        if (approved) {
          await submitApproval({ requestId, approved: true })
        } else {
          await submitApproval({ requestId, approved: false, reason: '用户拒绝审批' })
        }
        // 根据操作类型显示成功提示
        const actionText =
          action === 'approve'
            ? '同意'
            : action === 'reject'
              ? '拒绝'
              : '加入白名单'
        toast.success(`已${actionText}审批`)
        logger.debug('审批操作成功', { requestId, action })
      } catch (err) {
        toast.error('审批操作失败')
        logger.error('审批操作失败', { requestId, action, error: err })
      }
    },
    []
  )

  // ---- I-G-011: 派生搜索高亮数据 ----
  // 匹配的消息 ID 列表（用于 MessageList 高亮显示）
  const highlightedMessageIds = useMemo(
    () =>
      searchResults
        .map(idx => messages[idx]?.id)
        .filter((id): id is string => id !== undefined),
    [searchResults, messages]
  )
  // 当前定位到的匹配消息 ID（用于 MessageList scrollIntoView）
  const currentMatchMsgIdx = searchResults[currentMatchIdx]
  const currentHighlightId =
    currentMatchMsgIdx !== undefined ? messages[currentMatchMsgIdx]?.id : undefined

  // ---- 无活跃 thread：显示欢迎屏（含输入框） ----
  if (activeThreadId === null || activeThread === null) {
    return (
      <WelcomeScreen
        onPickPrompt={handlePickPrompt}
        onSend={handleWelcomeSend}
        isSending={createThreadMutation.isPending || startTurnMutation.isPending}
      />
    )
  }

  // ---- 有活跃 thread：渲染对话区 ----
  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {/* 网络状态横幅（断开/重连时显示，已连接时返回 null） */}
      <NetStatusBanner />

      {/* 对话内搜索栏（Ctrl/Cmd+F 切换，visible 为 false 时返回 null） */}
      <ConversationSearchBar
        visible={searchVisible}
        query={searchQuery}
        totalMatches={searchResults.length}
        currentMatch={searchResults.length > 0 ? currentMatchIdx + 1 : 0}
        onSearch={handleSearch}
        onNavigate={handleNavigate}
        onClose={closeSearch}
      />

      {/* 速率限制提示（达到限制时显示 pill，关闭后返回 null） */}
      <RateLimitBanner />

      {/* 消息列表 + 垂直进度条 */}
      {/* flex flex-col: 使子元素 MessageList 的 flex-1 min-h-0 生效，约束消息区高度不溢出覆盖 composer */}
      <div className="relative flex flex-1 min-h-0 flex-col">
        {/* 垂直进度条（覆盖在消息列表左侧） */}
        <VerticalProgressBar
          turns={turns}
          activeTurnId={activeTurn?.id ?? null}
          userMessages={userMessages}
          activeMessageIndex={activeMessageIndex}
          onDotClick={handleDotClick}
        />
        <MessageList
          messages={messages}
          threadId={activeThreadId}
          modelName={activeThread.model}
          isLoading={isLoading}
          highlightedMessageIds={highlightedMessageIds}
          currentHighlightId={currentHighlightId ?? null}
          onScrollActiveIndex={setActiveMessageIndex}
          scrollToMessageRef={scrollToMessageRef}
          onApprovalAction={handleApprovalAction}
          // A2: 传入重新生成回调，用户点击消息操作栏的"重新生成"按钮时触发
          onRegenerate={handleRegenerate}
        />
        {/* 内联审批卡片 — 当 approval-store 有 pendingApproval 时在消息列表末尾渲染 */}
        {/* 对齐原型：审批请求作为对话流中的内联卡片，而非独立弹窗 */}
        <ApprovalDialog />
      </div>

      {/* 输入框 */}
      <ChatInput
        threadId={activeThreadId as ThreadId}
        isSending={isSending || startTurnMutation.isPending}
        hasActiveTurn={activeTurn !== null && activeTurn.status === 'running'}
        onSend={handleSend}
        onCancel={handleCancel}
      />
    </div>
  )
}

// ─── Demo 注入辅助函数 ──────────────────────────────────────────

/**
 * 将 Demo 审批变体（7 种）映射到 store 的 ApprovalType（7 种）。
 *
 * 映射规则（1:1 直接对应，ApprovalVariant 与 ApprovalType 现已统一）：
 *   command → 'command'（命令执行审批）
 *   patch   → 'patch'（文件变更 / 补丁应用审批）
 *   tool    → 'tool'（工具输入请求）
 *   mcp     → 'mcp'（MCP Elicitation）
 *   perm    → 'perm'（权限授予审批）
 *   dyn     → 'dyn'（动态工具调用）
 *   attest  → 'attest'（Attestation 生成）
 *
 * 历史背景：旧版 ApprovalType 曾使用 'file_change' 和 'permissions'，
 * 后已分别合并为 'patch' 和重命名为 'perm'，故现在 ApprovalVariant
 * 与 ApprovalType 完全一致，本函数仅做类型透传。
 */
function mapDemoVariantToApprovalType(
  variant: 'command' | 'patch' | 'tool' | 'mcp' | 'perm' | 'dyn' | 'attest'
): 'command' | 'patch' | 'tool' | 'mcp' | 'perm' | 'dyn' | 'attest' {
  // ApprovalVariant 与 ApprovalType 现为同一组枚举值，直接透传
  return variant
}

/**
 * 根据 Demo 审批变体生成 mock 审批内容文本。
 * 用于在 ApprovalDialog 中展示对应变体的示例内容。
 */
function getDemoApprovalPayload(
  variant: 'command' | 'patch' | 'tool' | 'mcp' | 'perm' | 'dyn' | 'attest'
): string {
  const payloads: Record<typeof variant, string> = {
    command: 'npm run build',
    patch: 'src/components/Button.tsx (+12 -3)',
    tool: 'read_file(path="src/main.ts")',
    mcp: 'github.create_issue(title="Demo issue")',
    perm: '请求文件系统写入权限',
    dyn: 'dynamic_tool:search_web(query="demo")',
    attest: '生成 Attestation 证明',
  }
  return payloads[variant]
}

/* ============================================================
 * A1: Demo 消息 / 卡片 mock 数据解析与 Message 构造
 *
 * 以下辅助函数将 DemoInjectEvent 携带的 mockData（JSON 字符串）
 * 解析为结构化数据，并构造符合 Message 接口的对象，
 * 供 ConversationArea 通过 queryClient.setQueryData 插入到消息列表。
 *
 * 设计要点（低耦合 + 类型安全）：
 *  - 解析失败时返回空对象，构造函数使用兜底默认值，避免崩溃
 *  - 所有字段提取均通过类型守卫，不使用 any（项目硬约束：业务代码零 any）
 *  - 每条 mock 消息生成唯一 ID（demo-<type>-<timestamp>-<random>），
 *    避免与真实消息 ID 冲突
 * ============================================================ */

/**
 * 安全解析 JSON 字符串。
 * 解析失败时返回空对象，避免无效 JSON 导致组件崩溃。
 *
 * @param jsonText - JSON 字符串（可能为 undefined 或无效）
 * @returns 解析后的对象（解析失败返回空对象）
 */
function parseMockData(jsonText: string | undefined): Record<string, unknown> {
  if (!jsonText) return {}
  try {
    const parsed = JSON.parse(jsonText)
    // 仅接受对象类型（数组/原始值退化为空对象，由调用方使用默认值）
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {}
    }
    return parsed as Record<string, unknown>
  } catch {
    // JSON 解析失败：返回空对象，由调用方使用默认值
    return {}
  }
}

/**
 * 从未知对象中提取字符串字段。
 * 字段不存在或类型不匹配时返回空字符串（兜底默认值）。
 *
 * @param obj - 未知对象（通常为 JSON.parse 结果）
 * @param key - 字段名
 * @returns 字段值（字符串）或空字符串
 */
function getStringField(obj: unknown, key: string): string {
  if (typeof obj !== 'object' || obj === null) return ''
  const record = obj as Record<string, unknown>
  const val = record[key]
  return typeof val === 'string' ? val : ''
}

/**
 * 从未知对象中提取数字字段。
 * 字段不存在或类型不匹配时返回 0（兜底默认值）。
 *
 * @param obj - 未知对象
 * @param key - 字段名
 * @returns 字段值（数字）或 0
 */
function getNumberField(obj: unknown, key: string): number {
  if (typeof obj !== 'object' || obj === null) return 0
  const record = obj as Record<string, unknown>
  const val = record[key]
  return typeof val === 'number' && Number.isFinite(val) ? val : 0
}

/**
 * 从未知对象中提取对象字段（用于 ToolCall.args 等）。
 * 字段不存在或类型不匹配时返回空对象。
 *
 * @param obj - 未知对象
 * @param key - 字段名
 * @returns 字段值（Record）或空对象
 */
function getObjectField(
  obj: unknown,
  key: string
): Record<string, unknown> {
  if (typeof obj !== 'object' || obj === null) return {}
  const record = obj as Record<string, unknown>
  const val = record[key]
  if (typeof val !== 'object' || val === null || Array.isArray(val)) return {}
  return val as Record<string, unknown>
}

/**
 * mock 多工具并行数据中单个工具项的结构。
 */
interface MockToolItem {
  name: string
  status: string
}

/**
 * 从未知对象中提取 MockToolItem[] 字段（用于 multi-tool 卡片）。
 * 字段不存在或格式不符时返回空数组。
 *
 * 实现说明：
 *  - 使用 getStringField 提取字段，避免直接访问 index signature 属性
 *    （项目 tsconfig 启用了 noPropertyAccessFromIndexSignature）
 *  - 仅保留 name 和 status 均为非空字符串的项
 *
 * @param obj - 未知对象
 * @param key - 字段名
 * @returns 解析后的 MockToolItem 数组
 */
function getToolArrayField(obj: unknown, key: string): MockToolItem[] {
  if (typeof obj !== 'object' || obj === null) return []
  const record = obj as Record<string, unknown>
  const val = record[key]
  if (!Array.isArray(val)) return []
  return val
    .map(item => ({
      name: getStringField(item, 'name'),
      status: getStringField(item, 'status'),
    }))
    .filter(item => item.name !== '' && item.status !== '')
}

/**
 * mock 计划项数据中单个项的结构（来自 demo-injector 的 plan.items）。
 *
 * 支持任意层级嵌套（对齐原型 THREAD_PLANS 的树形结构）：
 *   - 叶子节点：只有 text + status
 *   - 父节点：额外带 children 数组
 */
interface MockPlanItem {
  text: string
  status: string
  /** 子步骤列表（可选，存在时表示父节点） */
  children?: MockPlanItem[]
}

/**
 * 从未知对象中提取 MockPlanItem[] 字段（用于 plan 消息）。
 * 字段不存在或格式不符时返回空数组。
 * 递归解析 children 字段，支持任意层级嵌套。
 *
 * @param obj - 未知对象
 * @param key - 字段名
 * @returns 解析后的 MockPlanItem 数组（含递归 children）
 */
function getPlanArrayField(obj: unknown, key: string): MockPlanItem[] {
  if (typeof obj !== 'object' || obj === null) return []
  const record = obj as Record<string, unknown>
  const val = record[key]
  if (!Array.isArray(val)) return []
  // 递归解析函数：支持嵌套 children
  const parseItem = (raw: unknown): MockPlanItem | null => {
    if (typeof raw !== 'object' || raw === null) return null
    const text = getStringField(raw, 'text')
    const status = getStringField(raw, 'status')
    // 容错：text 或 status 为空时跳过该项
    if (text === '' || status === '') return null
    // 递归解析 children（可选字段）—— 用 ['children'] 访问以兼容
    // noPropertyAccessFromIndexSignature 严格选项
    const childrenRaw = (raw as Record<string, unknown>)['children']
    let children: MockPlanItem[] | undefined
    if (Array.isArray(childrenRaw)) {
      children = childrenRaw
        .map(child => parseItem(child))
        .filter((c): c is MockPlanItem => c !== null)
      // children 为空数组时视为叶子节点
      if (children.length === 0) children = undefined
    }
    // exactOptionalPropertyTypes: true 下，undefined 不能直接赋给可选属性，
    // 用条件展开仅在 children 有值时附加该字段
    return {
      text,
      status,
      ...(children !== undefined ? { children } : {}),
    }
  }
  return val
    .map(item => parseItem(item))
    .filter((item): item is MockPlanItem => item !== null)
}

/**
 * mock diff 行的结构（来自 demo-injector 的 file-change.diff）。
 */
interface MockDiffLine {
  type: string
  text: string
}

/**
 * 从未知对象中提取 MockDiffLine[] 字段（用于 file-change 卡片）。
 * 字段不存在或格式不符时返回空数组。
 *
 * @param obj - 未知对象
 * @param key - 字段名
 * @returns 解析后的 MockDiffLine 数组
 */
function getDiffArrayField(obj: unknown, key: string): MockDiffLine[] {
  if (typeof obj !== 'object' || obj === null) return []
  const record = obj as Record<string, unknown>
  const val = record[key]
  if (!Array.isArray(val)) return []
  return val
    .map(item => ({
      type: getStringField(item, 'type'),
      text: getStringField(item, 'text'),
    }))
    .filter(item => item.type !== '' && item.text !== '')
}

/**
 * 将 mock diff 行类型（'ctx'/'add'/'del'）映射到 DiffLine.type（'context'/'add'/'del'）。
 * 未知类型默认为 'context'（上下文行）。
 *
 * @param mockType - mock 数据中的行类型字符串
 * @returns 对应的 DiffLine.type 枚举值
 */
function mapDiffLineType(mockType: string): 'context' | 'add' | 'del' {
  switch (mockType) {
    case 'add':
      return 'add'
    case 'del':
      return 'del'
    default:
      // 'ctx' 或其他未知类型统一映射为 'context'
      return 'context'
  }
}

/**
 * 将 mock 计划项状态字符串映射到 PlanItemStatus 枚举。
 * 未知状态默认为 'pending'（待执行）。
 *
 * @param mockStatus - mock 数据中的状态字符串
 * @returns 对应的 PlanItemStatus 枚举值
 */
function mapPlanItemStatus(mockStatus: string): PlanItemStatus {
  switch (mockStatus) {
    case 'active':
      return 'active'
    case 'done':
      return 'done'
    case 'skipped':
      return 'skipped'
    default:
      // 未知状态默认为 pending
      return 'pending'
  }
}

/**
 * 生成带时间戳和随机后缀的唯一 ID。
 * 用于 Demo mock 消息，避免与真实消息 ID 冲突。
 *
 * @param prefix - ID 前缀（如 'demo-msg'、'demo-card'）
 * @returns 形如 "demo-msg-1700000000000-abc123" 的唯一字符串
 */
function generateDemoId(prefix: string): string {
  const timestamp = Date.now()
  const random = Math.random().toString(36).slice(2, 8)
  return `${prefix}-${timestamp}-${random}`
}

/**
 * 根据 DemoMessageType 构造 mock Message 对象。
 *
 * 各类型构造规则：
 *  - reasoning: 构造 assistant 角色的 reasoning 消息（带 ReasoningBlock）
 *  - plan: 构造 assistant 角色的 plan 消息（带 PlanItem[]）
 *  - rate: 不构造 Message，返回 null（由调用方派发 'codex:rate-limit' 事件触发 RateLimitBanner）
 *  - user-* 系列: 构造 user 角色的 text 消息（带代码块/错误日志等附加内容）
 *  - interrupted/whitelist/recover: 构造 system 角色的 text 消息（系统提示）
 *  - complete: 构造 assistant 角色的 text 消息（完成总结）
 *
 * @param type - Demo 消息类型
 * @param mockData - 携带的 JSON 字符串 mock 数据
 * @returns 构造好的 Message 对象，或 null（rate 类型不构造消息）
 */
function createDemoMessage(
  type: DemoMessageType,
  mockData: string | undefined
): Message | null {
  const now = Date.now()
  const id = generateDemoId('demo-msg')
  const data = parseMockData(mockData)

  switch (type) {
    // ── 推理摘要块 ──
    case 'reasoning': {
      const reasoningText = getStringField(data, 'text')
      return {
        id,
        role: 'assistant',
        content: 'reasoning',
        text: '',
        timestamp: now,
        reasoning: {
          id: generateDemoId('demo-reasoning'),
          content: reasoningText,
          durationMs: getNumberField(data, 'durationMs') || 3200,
          tokenCount: getNumberField(data, 'tokens') || 412,
          isStreaming: false,
        },
      }
    }

    // ── 执行计划块 ──
    case 'plan': {
      const mockItems = getPlanArrayField(data, 'items')
      // 递归适配嵌套 mock 结构为 PlanItem（支持 children 树形结构）
      const adaptPlanItem = (
        item: MockPlanItem,
        index: number
      ): PlanItem => {
        const children = item.children?.map((c, i) => adaptPlanItem(c, i + 1))
        // exactOptionalPropertyTypes: true 下，仅当 children 非空时才附加该字段
        return {
          index,
          text: item.text,
          status: mapPlanItemStatus(item.status),
          ...(children && children.length > 0 ? { children } : {}),
        }
      }
      const planItems: PlanItem[] = mockItems.map((item, idx) =>
        adaptPlanItem(item, idx + 1)
      )
      return {
        id,
        role: 'assistant',
        content: 'plan',
        text: '',
        timestamp: now,
        planItems,
      }
    }

    // ── 速率限制横幅 ──
    // 不构造 Message，由调用方派发 'codex:rate-limit' 事件触发 RateLimitBanner
    case 'rate': {
      return null
    }

    // ── 用户消息系列（含代码块 / 附件 / 长文本 / 错误日志）──
    case 'user-code':
    case 'user-attach':
    case 'user-long':
    case 'user-error': {
      let text = getStringField(data, 'text')
      // user-code：附加编译错误代码块（``` 包裹）
      if (type === 'user-code') {
        const code = getStringField(data, 'code')
        if (code) text += `\n\n\`\`\`\n${code}\n\`\`\``
      }
      // user-error：附加错误堆栈代码块
      if (type === 'user-error') {
        const errorMsg = getStringField(data, 'error')
        if (errorMsg) text += `\n\n\`\`\`\n${errorMsg}\n\`\`\``
      }
      // user-attach：附加文件列表
      if (type === 'user-attach') {
        // 使用 ['attachments'] 访问，避免 noPropertyAccessFromIndexSignature 错误
        const attachments = data['attachments']
        if (Array.isArray(attachments)) {
          const fileList = attachments
            .filter((a): a is string => typeof a === 'string')
            .map(a => `@${a}`)
            .join(' ')
          if (fileList) text += `\n\n${fileList}`
        }
      }
      return {
        id,
        role: 'user',
        content: 'text',
        text,
        timestamp: now,
      }
    }

    // ── 中断提示 ──
    case 'interrupted': {
      return {
        id,
        role: 'system',
        content: 'text',
        text: `已中断：${getStringField(data, 'reason')}`,
        timestamp: now,
      }
    }

    // ── 白名单提示 ──
    case 'whitelist': {
      const command = getStringField(data, 'command')
      const message = getStringField(data, 'message')
      return {
        id,
        role: 'system',
        content: 'text',
        text: `${command} — ${message || '已加入白名单，自动执行'}`,
        timestamp: now,
      }
    }

    // ── 中断恢复提示 ──
    case 'recover': {
      return {
        id,
        role: 'system',
        content: 'text',
        text: getStringField(data, 'message') || '已恢复中断的生成',
        timestamp: now,
      }
    }

    // ── 完成总结 ──
    case 'complete': {
      return {
        id,
        role: 'assistant',
        content: 'text',
        text: getStringField(data, 'text') || '综合演示已完成',
        timestamp: now,
      }
    }
  }
}

/**
 * 根据 DemoCardType 构造 mock Message 对象（content 为 tool_call 或 file_change）。
 *
 * 各卡片类型构造规则：
 *  - tool-running: 构造 tool_call 消息，status='running'（执行中）
 *  - tool-error: 构造 tool_call 消息，status='error'（工具调用失败）
 *  - cmd-error: 构造 tool_call 消息（exec_command），status='error'（命令非零退出）
 *  - cmd-success: 构造 tool_call 消息（exec_command），status='success'（命令成功）
 *  - multi-tool: 构造 tool_call 汇总消息（包含 3 个工具的状态概览）
 *  - file-change: 构造 file_change 消息（含 diff 行）
 *
 * @param type - Demo 卡片类型
 * @param mockData - 携带的 JSON 字符串 mock 数据
 * @returns 构造好的 Message 对象
 */
function createDemoCardMessage(
  type: DemoCardType,
  mockData: string | undefined
): Message {
  const now = Date.now()
  const id = generateDemoId('demo-card')
  const data = parseMockData(mockData)

  switch (type) {
    // ── 工具执行中 ──
    case 'tool-running': {
      // exactOptionalPropertyTypes: result 为可选属性，仅在非空时添加
      // （直接赋 `string | undefined` 会触发 TS2375 错误）
      const output = getStringField(data, 'output')
      const toolCall: ToolCall = {
        id: generateDemoId('demo-tool'),
        name: getStringField(data, 'tool'),
        args: getObjectField(data, 'args'),
        status: 'running',
        // 仅在 output 非空时添加 result 字段，避免 exactOptionalPropertyTypes 错误
        ...(output !== '' ? { result: output } : {}),
      }
      return {
        id,
        role: 'assistant',
        content: 'tool_call',
        text: '',
        timestamp: now,
        toolCall,
      }
    }

    // ── 工具错误（如 read_file 文件不存在）──
    case 'tool-error': {
      const toolCall: ToolCall = {
        id: generateDemoId('demo-tool'),
        name: getStringField(data, 'tool'),
        args: getObjectField(data, 'args'),
        status: 'error',
        error: getStringField(data, 'error') || '未知错误',
      }
      return {
        id,
        role: 'assistant',
        content: 'tool_call',
        text: '',
        timestamp: now,
        toolCall,
      }
    }

    // ── 命令错误（非零退出码）──
    case 'cmd-error': {
      const toolCall: ToolCall = {
        id: generateDemoId('demo-cmd'),
        name: 'exec_command',
        args: { command: getStringField(data, 'command') },
        status: 'error',
        error: getStringField(data, 'stderr'),
      }
      return {
        id,
        role: 'assistant',
        content: 'tool_call',
        text: '',
        timestamp: now,
        toolCall,
      }
    }

    // ── 命令成功（零退出码 + stdout）──
    case 'cmd-success': {
      const toolCall: ToolCall = {
        id: generateDemoId('demo-cmd'),
        name: 'exec_command',
        args: { command: getStringField(data, 'command') },
        status: 'success',
        result: getStringField(data, 'stdout'),
      }
      return {
        id,
        role: 'assistant',
        content: 'tool_call',
        text: '',
        timestamp: now,
        toolCall,
      }
    }

    // ── 多工具并行（3 个工具并发执行）──
    // 由于 Message 接口仅支持单个 toolCall，此处插入一条汇总消息，
    // 包含所有工具的状态概览，便于在对话流中展示多工具并行的效果。
    case 'multi-tool': {
      const tools = getToolArrayField(data, 'tools')
      const summary = tools
        .map(t => `${t.name}: ${t.status}`)
        .join(', ')
      const toolCall: ToolCall = {
        id: generateDemoId('demo-multi'),
        name: 'multi_tool',
        args: { tools },
        status: 'running',
        result: summary,
      }
      return {
        id,
        role: 'assistant',
        content: 'tool_call',
        text: '',
        timestamp: now,
        toolCall,
      }
    }

    // ── 文件变更卡片（diff 展示）──
    case 'file-change': {
      const mockDiff = getDiffArrayField(data, 'diff')
      const diffLines: DiffLine[] = mockDiff.map(line => ({
        type: mapDiffLineType(line.type),
        content: line.text,
      }))
      const fileChange: FileChange = {
        path: getStringField(data, 'file'),
        type: 'modified',
        additions: getNumberField(data, 'additions'),
        deletions: getNumberField(data, 'deletions'),
        diff: diffLines,
      }
      return {
        id,
        role: 'assistant',
        content: 'file_change',
        text: '',
        timestamp: now,
        fileChange,
      }
    }
  }
}

/**
 * WelcomeScreen — 欢迎屏
 *
 * 对应 prototype.html 的 `.view-chat.welcome-mode .thread` 布局：
 *   display:flex; flex-direction:column; align-items:center; justify-content:center; gap:16px; padding:24px
 *
 * C13 布局：logo + composer + 快捷入口 三者垂直居中排列：
 * 1. logo + 标语在最上
 * 2. ChatInput（welcomeMode）在中间
 * 3. WelcomeQuickActions 在最下
 *
 * 用户可在欢迎页直接输入文字发送消息，发送时自动创建新会话。
 */
interface WelcomeScreenProps {
  /** 快捷入口点击回调，参数为对应的 prompt 文本 */
  onPickPrompt: (prompt: string) => void
  /** 输入框发送消息回调（先创建 thread 再发送） */
  onSend: (text: string) => void
  /** 是否正在发送（禁用输入框） */
  isSending?: boolean
}

function WelcomeScreen({ onPickPrompt, onSend, isSending = false }: WelcomeScreenProps) {
  return (
    // C13: 整个欢迎屏垂直居中排列 logo + composer + 快捷入口（对齐 .view-chat.welcome-mode .thread）
    // C13: 四周 padding 24px（对齐原型 .view-chat.welcome-mode .thread { padding:24px }）
    // P0 修复：补 relative（对齐原型 .view-chat.welcome-mode .thread { position:relative }）
    <div className="relative flex h-full flex-col items-center justify-center gap-4 px-6 py-6">
      {/* logo + 标语（最上） */}
      <div className="flex flex-col items-center gap-2">
        {/* P0 修复：letter-spacing 从 tracking-tight(-0.025em) 改为 tracking-[-0.02em]（对齐原型 -0.02em）
            并上移到父 div 让 icon 与标题同时继承（原型 .welcome-logo { letter-spacing:-0.02em } 同时作用于 icon 和标题） */}
        <div className="flex items-center gap-3 tracking-[-0.02em]">
          {/* 图标（参考 prototype 的 .wl-icon，使用 ⟨/⟩ 符号） */}
          <span className="text-[32px] font-normal text-[var(--text)]">⟨/⟩</span>
          {/* data-slot="welcome-title"：供 App.css 中 .is-minimal [data-slot='welcome-title'] { font-size:20px } 规则匹配 */}
          <span data-slot="welcome-title" className="text-[30px] font-semibold text-[var(--text)]">
            Code with TRAE
          </span>
        </div>
        {/* data-slot="welcome-desc"：供 App.css 中 .is-minimal [data-slot='welcome-desc'] { font-size:12px } 规则匹配 */}
        <p data-slot="welcome-desc" className="text-[13px] text-[var(--text-dim)]">
          AI 驱动的智能编程助手，让开发更高效
        </p>
      </div>
      {/* composer（中间，welcomeMode 启用 720px 宽度 + 透明背景） */}
      <ChatInput
        threadId={WELCOME_THREAD_ID}
        isSending={isSending}
        onSend={onSend}
        welcomeMode
        className="w-full"
      />
      {/* 快捷入口（最下，参考 .welcome-quick-actions）— 4 个 pill 按钮 */}
      {/* C13: 宽度约束（对齐 .view-chat.welcome-mode .welcome-quick-actions { max-width:720px; width:100% }） */}
      <div className="w-full max-w-[720px]">
        <WelcomeQuickActions onPickPrompt={onPickPrompt} />
      </div>
    </div>
  )
}
