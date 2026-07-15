/**
 * ChatInput — 对话输入框
 *
 * 对应 prototype.html 的 `.composer` 输入区域。
 * 功能：
 * - 多行文本输入（自动调整高度）
 * - Enter 发送消息，Shift+Enter 换行
 * - 草稿持久化（通过 draft-store 按 thread 隔离保存）
 * - 发送按钮（accent 色）
 * - 发送中禁用输入
 * - Esc 键中断正在进行的轮次
 * - 工具按钮区：附件按钮（mock 添加附件）+ 斜杠命令按钮
 * - 斜杠命令建议弹窗：输入 "/" 自动弹出，支持键盘导航（↑↓ Enter Tab Esc）
 * - 附件列表：chip 样式显示已添加的附件，可点击 × 移除
 *
 * 草稿机制说明：
 *   用户输入内容会实时保存到 draft-store（按 threadId 隔离），
 *   切换 thread 后恢复对应草稿，发送后清除草稿。
 *
 * 参考样式：prototype.html 第 1468-1660 行（composer-bar / composer-tools）
 *           prototype.html 第 3377-3477 行（composer-attachments / suggest-pop）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowUp,
  ChevronDown,
  File,
  Folder,
  Monitor,
  Paperclip,
  Slash,
  Square,
  X,
} from 'lucide-react'
import type { ChatStats, ThreadId } from '@/lib/codex/types'
import { useDraftStore } from '@/store/draft-store'
import { cn } from '@/lib/utils'
import { isTauri } from '@/lib/env'
// 集中式 mock 数据 — 统计栏指标从 MockData 统一获取
import { getMockData } from '@/lib/codex/mock'
// toast 通知（用于空消息、长度超限、命令选择等交互反馈）
import { toast } from 'sonner'
// B1: 斜杠命令 /clear 需要清空消息缓存
import { useQueryClient } from '@tanstack/react-query'
import { messagesQueryKeys, invalidateMessages } from '@/queries/messages'
// B1: 斜杠命令 /clear 需要清空对话 UI 状态
import { useConversationStore } from './conversation-store'
// B1: 斜杠命令 /help 需要打开快捷键帮助弹窗
import { useDialogStore } from '@/store/dialog-store'

export interface ChatInputProps {
  /** 当前 thread ID */
  threadId: ThreadId
  /** 是否正在发送消息（禁用输入框） */
  isSending?: boolean
  /** 是否有活跃轮次（用于显示中断按钮） */
  hasActiveTurn?: boolean
  /** 发送消息回调 */
  onSend: (text: string) => void
  /** 中断轮次回调 */
  onCancel?: () => void
  className?: string
  /** 当前模型名（项目栏显示） */
  modelName?: string | undefined
  /** 消息数（统计栏显示） */
  messageCount?: number
  /** 轮次数（统计栏显示） */
  turnCount?: number
  /** Token 用量（统计栏显示） */
  tokenCount?: number
  /** 账户名（统计栏显示） */
  accountName?: string | undefined
  /** 状态（统计栏显示） */
  status?: 'ready' | 'running' | 'error' | undefined
  /**
   * 是否为欢迎屏模式（对齐原型 .view-chat.welcome-mode .composer）。
   * 为 true 时：
   * - composer 最大宽度 720px（否则 820px）
   * - 去除顶边框、背景透明、内边距归零
   * - 隐藏统计栏
   */
  welcomeMode?: boolean
}

/** 输入框最小高度（px） */
const MIN_HEIGHT = 24
/** 输入框最大高度（px），超出后出现滚动条 */
const MAX_HEIGHT = 160
/** 输入框 placeholder 文案 */
const PLACEHOLDER =
  '帮你编写代码、测试Bug、优化性能等开发工作，交付生产级代码产物。'

/* ===== 拖拽手柄相关常量 ===== */
/** 拖拽调整高度的最小值（px） */
const DRAG_MIN_HEIGHT = 40
/** 拖拽调整高度的最大值（px） */
const DRAG_MAX_HEIGHT = 460

/* ===== 字符计数器相关常量 ===== */
/** 字符计数警告阈值（超过此值显示警告色和上限） */
const CHAR_WARN_THRESHOLD = 2000
/** 字符计数上限（警告时显示） */
const CHAR_LIMIT = 8000

/* ===== 斜杠命令建议弹窗相关常量 ===== */
/** 斜杠命令定义类型：title=命令名，sub=描述，icon=图标字母 */
interface SlashCommand {
  title: string
  sub: string
  icon: string
}
/**
 * 斜杠命令列表（参考 prototype.html SLASH_CMDS）。
 * 用户在输入框输入 "/" 后会弹出此列表供选择。
 * B1: 新增 /plan 和 /summarize 命令，支持路由到对应 API 操作。
 */
const SLASH_CMDS: readonly SlashCommand[] = [
  { title: '/clear', sub: '清空当前会话消息历史', icon: 'C' },
  { title: '/compact', sub: '压缩上下文 · ContextCompacted', icon: 'C' },
  { title: '/goal', sub: '设置当前会话目标 · ThreadGoalSet', icon: 'G' },
  { title: '/help', sub: '显示帮助信息', icon: 'H' },
  { title: '/interrupt', sub: '中断当前 turn · TurnInterrupt', icon: 'I' },
  { title: '/model', sub: '切换模型', icon: 'M' },
  { title: '/plan', sub: '进入计划模式 · 下次发送附带 plan 指令', icon: 'P' },
  { title: '/rollback', sub: '回滚到指定 turn · ThreadRollback', icon: 'R' },
  { title: '/steer', sub: '转向 · TurnSteer', icon: 'S' },
  { title: '/settings', sub: '打开设置', icon: 'S' },
  { title: '/summarize', sub: '生成本轮摘要 · 发送 summarize 指令', icon: 'S' },
]
/** 斜杠命令查询的最大长度（超过则不触发建议弹窗） */
const SLASH_QUERY_MAX_LEN = 20
/** @提及查询的最大长度（对齐原型，超过则不触发建议弹窗） */
const MENTION_QUERY_MAX_LEN = 30

/* ===== "@" 提及文件列表（mock 项目文件，用于 @ 触发的文件建议弹窗） ===== */
const MENTION_FILES: readonly string[] = [
  'src/main.rs',
  'src/lib.rs',
  'Cargo.toml',
  'README.md',
  'src/bridge.rs',
  'src/config.rs',
]

/* ===== 项目栏静态数据（后续可从外部接入） ===== */
/** 项目选项列表 */
const PROJECT_OPTIONS: readonly string[] = ['codex-rs', 'Agent2', 'prototype']
/** 模型选项列表 */
const MODEL_OPTIONS: readonly string[] = [
  'gpt-5-codex',
  'gpt-5',
  'claude-sonnet-4',
]
/** 默认模型名 */
const DEFAULT_MODEL_NAME = 'gpt-5-codex'
/** 默认账户名（对齐原型统计栏 #csbAccount 的显示值） */
const DEFAULT_ACCOUNT_NAME = 'dev@codex.dev'
/** 默认项目名 */
const DEFAULT_PROJECT_NAME = 'codex-rs'

/* ===== 统计栏扩展指标（从 MockData 获取，支持场景切换） ===== */
/**
 * 聊天统计栏指标（token 速率、速率限制、安全缓冲、模型重路由）。
 * 浏览器开发模式从 MockData 获取；Tauri 生产模式返回空值占位，
 * 真实数据由后端流式通知或 API 接入，避免 mock 数据泄漏到生产环境。
 *
 * 注意：chatStats 已移至组件内部 state（见组件内 useState），
 * 原模块级常量在 Tauri 模式下永远为空值占位，后端数据无法更新。
 */
/** 安全缓冲警告阈值（低于此百分比时显示 warn 色，提示缓冲不足） */
const SAFETY_BUFFER_WARN_THRESHOLD = 50

/**
 * ChatInput 组件 —— 对话输入框。
 *
 * 渲染层次：
 *  1. composer-box：textarea + 工具按钮（附件 / 斜杠命令）+ 快捷键提示 + 字符计数器 + 发送/中断按钮
 *  2. composer-project-bar：本地标识 + 项目下拉 + 模型下拉
 *  3. composer-stats-bar：状态 / 消息数 / 轮次 / Token / 速率 / 账户 / 速率限制 / 安全缓冲 / 模型重路由
 *  4. composer-drag-handle：可拖拽调整 textarea 高度（双击重置）
 *
 * 状态依赖：
 *  - draft-store：按 threadId 隔离的输入草稿（切换会话后自动恢复）
 *  - 内部 useState：文本、附件列表、项目栏下拉、斜杠建议索引、拖拽中状态等
 *
 * 副作用：
 *  - thread 切换时从 draft-store 恢复草稿（渲染期间 setState 模式）
 *  - 拖拽时挂载 document 级 mousemove/mouseup 监听
 *  - 字符超阈值时显示警告色与上限
 *
 * @param props —— 见 ChatInputProps 接口
 */
export function ChatInput({
  threadId,
  isSending = false,
  hasActiveTurn = false,
  onSend,
  onCancel,
  className,
  modelName,
  messageCount = 0,
  turnCount = 0,
  tokenCount = 0,
  accountName,
  status,
  welcomeMode = false,
}: ChatInputProps) {
  // 草稿 store 操作
  const getDraft = useDraftStore(s => s.getDraft)
  const setDraft = useDraftStore(s => s.setDraft)
  const clearDraft = useDraftStore(s => s.clearDraft)

  // B1: 斜杠命令所需的 store / queryClient
  const queryClient = useQueryClient()
  const clearThreadState = useConversationStore(s => s.clearThread)
  const setShortcutHelpOpen = useDialogStore(s => s.setShortcutHelpOpen)

  // Bug 1 修复：chatStats 从模块级常量改为组件内 state，
  // 以便 Tauri 模式下后续通过后端事件动态更新（原模块级常量在 Tauri 模式下永远为空值占位）
  // TODO: 后续通过监听后端事件动态更新 chatStats（届时解构出 setChatStats）
  const [chatStats] = useState<ChatStats>(() =>
    isTauri()
      ? { tokenRate: '', rateLimit: '', safetyBufferPercent: 100, modelReroute: '' }
      : getMockData().chatStats
  )

  // B1: 计划模式标志（/plan 命令设置，下次发送时附带 plan 指令）
  const [planMode, setPlanMode] = useState(false)

  // 输入框文本状态（从草稿恢复）
  const [text, setText] = useState(() => getDraft(threadId))
  // 跟踪上一个 threadId，用于在 thread 切换时重置文本（避免 useEffect 级联渲染）
  const [prevThreadId, setPrevThreadId] = useState(threadId)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  /* ===== 拖拽手柄相关状态 ===== */
  // 当前可拖拽的最大高度（ref 避免 stale closure，state 驱动 React 重渲染）
  const dragMaxHeightRef = useRef<number>(MAX_HEIGHT)
  const [dragMaxHeight, setDragMaxHeightState] = useState<number>(MAX_HEIGHT)
  // 拖拽中状态（控制手柄可见性）
  const [isDragging, setIsDragging] = useState<boolean>(false)
  // 拖拽过程数据（ref 避免 setState 频繁重渲染）
  const dragRef = useRef({
    dragging: false,
    startY: 0,
    startMaxHeight: MAX_HEIGHT,
  })
  // 拖拽最小高度（动态计算：取当前文本内容的自然高度，避免拖拽时丢失已输入内容）
  const dragMinHeightRef = useRef<number>(DRAG_MIN_HEIGHT)

  // 更新拖拽最大高度（同步更新 ref 和 state）
  const setDragMaxHeight = useCallback((value: number) => {
    dragMaxHeightRef.current = value
    setDragMaxHeightState(value)
  }, [])

  /* ===== 项目栏相关状态 ===== */
  // 当前选中的项目名
  const [selectedProject, setSelectedProject] = useState<string>(DEFAULT_PROJECT_NAME)
  // 当前选中的模型名（从 props 初始化，props 变化时同步）
  const [selectedModel, setSelectedModel] = useState<string>(
    modelName ?? DEFAULT_MODEL_NAME
  )
  const [prevModelName, setPrevModelName] = useState(modelName)
  if (modelName !== prevModelName) {
    setPrevModelName(modelName)
    setSelectedModel(modelName ?? DEFAULT_MODEL_NAME)
  }
  // 当前打开的下拉菜单（null 表示全部关闭）
  // I-M-005: 扩展 'attach' 类型用于附件下拉菜单
  const [openDropdown, setOpenDropdown] = useState<
    'project' | 'model' | 'attach' | null
  >(null)

  /* ===== 斜杠命令建议弹窗相关状态 ===== */
  // 当前选中的建议项索引（键盘导航 ↑↓ 用）
  const [suggestActive, setSuggestActive] = useState(0)
  // 建议弹窗是否被手动关闭（Esc 关闭后不再自动弹出，直到文本变化后重置）
  const [suggestDismissed, setSuggestDismissed] = useState(false)
  // 当前激活项的 DOM 引用（键盘导航时滚动到可视区域）
  const activeItemRef = useRef<HTMLButtonElement | null>(null)

  /* ===== 附件列表相关状态 ===== */
  // 附件列表（mock：每个附件包含文件名和路径）
  const [attachments, setAttachments] = useState<
    { name: string; path: string }[]
  >([])
  // I-M-005: 隐藏的文件/文件夹选择 input 的 ref（用于附件按钮下拉菜单触发原生选择器）
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const folderInputRef = useRef<HTMLInputElement | null>(null)

  // thread 切换时恢复对应草稿（React 推荐模式：在渲染阶段调整 state，而非 useEffect）
  if (threadId !== prevThreadId) {
    setPrevThreadId(threadId)
    setText(getDraft(threadId))
  }

  /* ===== 斜杠命令 / @提及 建议弹窗派生状态 ===== */
  // P2-12: 使用 lastIndexOf 检测光标前最近的触发字符，支持在文本任意位置触发
  // （原先用 startsWith 仅在文本开头触发，与原型 lastIndexOf 行为不一致）
  // 分别查找文本中最后一个 '/' 和 '@' 的位置
  const slashIdx = text.lastIndexOf('/')
  const atIdx = text.lastIndexOf('@')
  // 斜杠命令查询串（'/' 之后到文本末尾的部分）
  const slashQuery = slashIdx !== -1 ? text.slice(slashIdx + 1) : ''
  // @提及查询串（'@' 之后到文本末尾的部分）
  const mentionQuery = atIdx !== -1 ? text.slice(atIdx + 1) : ''
  // 斜杠命令触发条件：'/' 存在 + 查询串非空 + 不超过上限 + 无空格
  const isSlashTriggered =
    slashIdx !== -1 &&
    slashQuery.length > 0 &&
    slashQuery.length <= SLASH_QUERY_MAX_LEN &&
    !slashQuery.includes(' ')
  // @提及触发条件：'@' 存在 + 查询串非空 + 不超过上限 + 无空格
  const isMentionTriggered =
    atIdx !== -1 &&
    mentionQuery.length > 0 &&
    mentionQuery.length <= MENTION_QUERY_MAX_LEN &&
    !mentionQuery.includes(' ')
  // 触发类型：两者都满足时取位置更靠后的（更接近光标），否则取唯一满足者
  const triggerType: 'slash' | 'mention' | null =
    isSlashTriggered && isMentionTriggered
      ? atIdx > slashIdx
        ? 'mention'
        : 'slash'
      : isSlashTriggered
        ? 'slash'
        : isMentionTriggered
          ? 'mention'
          : null
  // 查询字符串（当前触发类型对应的查询串，用于过滤建议列表）
  // 例如输入 "hello /fix" → query="fix"；输入 "hi @main" → query="main"
  const triggerQuery =
    triggerType === 'slash'
      ? slashQuery
      : triggerType === 'mention'
        ? mentionQuery
        : ''
  // 是否显示建议弹窗
  // 条件：未被手动关闭 + 有有效触发类型（触发条件已在上方校验：无空格 + 长度不超限）
  const isSuggestOpen = !suggestDismissed && triggerType !== null
  // 过滤后的斜杠命令列表（按标题或描述模糊匹配，不区分大小写）
  const filteredCmds = useMemo(() => {
    if (!isSuggestOpen || triggerType !== 'slash') return [] as SlashCommand[]
    const q = triggerQuery.toLowerCase()
    return SLASH_CMDS.filter(
      cmd =>
        cmd.title.toLowerCase().includes(q) ||
        cmd.sub.toLowerCase().includes(q)
    )
  }, [isSuggestOpen, triggerType, triggerQuery])
  // I-M-004: 过滤后的文件列表（@提及文件，按路径模糊匹配，不区分大小写）
  const filteredFiles = useMemo(() => {
    if (!isSuggestOpen || triggerType !== 'mention') return [] as string[]
    const q = triggerQuery.toLowerCase()
    return MENTION_FILES.filter(f => f.toLowerCase().includes(q))
  }, [isSuggestOpen, triggerType, triggerQuery])
  // 当前建议弹窗的候选项总数（斜杠命令或文件列表）
  const suggestItemsCount =
    triggerType === 'slash' ? filteredCmds.length : filteredFiles.length

  // 查询字符串变化时重置选中项索引到第一项
  // 使用渲染期间调整 state 的模式（与 prevThreadId/prevModelName 一致），避免 effect 内 setState 导致级联渲染
  const [prevTriggerQuery, setPrevTriggerQuery] = useState(triggerQuery)
  if (triggerQuery !== prevTriggerQuery) {
    setPrevTriggerQuery(triggerQuery)
    setSuggestActive(0)
  }

  // 激活项变化时滚动到可视区域（键盘导航时确保当前项可见）
  useEffect(() => {
    activeItemRef.current?.scrollIntoView({ block: 'nearest' })
  }, [suggestActive])

  // 自动调整输入框高度（使用 ref 获取最新的 dragMaxHeight，避免 stale closure）
  const autoResize = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    // 先重置高度以获取正确的 scrollHeight
    textarea.style.height = 'auto'
    // 限制在最小和当前拖拽最大高度之间
    const newHeight = Math.min(
      Math.max(textarea.scrollHeight, MIN_HEIGHT),
      dragMaxHeightRef.current
    )
    textarea.style.height = `${newHeight}px`
  }, [])

  // 文本变化时更新状态、保存草稿、调整高度
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value
      setText(value)
      setDraft(threadId, value)
      // 文本变化时重置建议弹窗的关闭状态（允许重新弹出）
      setSuggestDismissed(false)
      // 在下一帧调整高度（等待 DOM 更新）
      requestAnimationFrame(autoResize)
    },
    [threadId, setDraft, autoResize]
  )

  // B1: 斜杠命令处理器映射表。
  // 每个命令对应一个处理函数，选中或发送时执行对应操作。
  // 返回 true 表示命令已处理（不需要继续发送消息），false 表示走默认流程。
  const commandHandlers = useMemo(
    () => ({
      // /clear: 清空当前 thread 的消息缓存和 UI 状态
      '/clear': () => {
        queryClient.setQueryData(messagesQueryKeys.byThread(threadId), [])
        invalidateMessages(queryClient, threadId)
        clearThreadState(threadId)
        toast.success('已清空当前会话消息')
      },
      // /help: 打开快捷键帮助弹窗
      '/help': () => {
        setShortcutHelpOpen(true)
        toast.info('已打开快捷键帮助')
      },
      // /plan: 进入计划模式（下次发送时附带 plan 指令）
      '/plan': () => {
        setPlanMode(true)
        toast.info('已进入计划模式，下次发送将附带 plan 指令')
      },
      // /summarize: 发送 summarize 指令
      '/summarize': () => {
        onSend('summarize')
        toast.info('已发送 summarize 指令')
      },
    }),
    [queryClient, threadId, clearThreadState, setShortcutHelpOpen, onSend]
  )

  // 发送消息
  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    // 正在发送中时不允许重复发送
    if (isSending) return
    // I-M-001: 空消息时给出 toast 提示并聚焦输入框（非静默返回）
    if (trimmed === '') {
      toast.warning('请输入消息')
      textareaRef.current?.focus()
      return
    }
    // I-M-002: 字符上限强制限制（对齐原型 8000 字符上限）
    if (text.length > CHAR_LIMIT) {
      toast.warning(`消息过长（>${CHAR_LIMIT} 字符），请精简或拆分`)
      return
    }

    // B1: 检测斜杠命令（以 / 开头的单个单词）
    const commandMatch = trimmed.match(/^(\/\w+)\s*$/)
    if (commandMatch) {
      const cmd = commandMatch[1]
      const handler = commandHandlers[cmd as keyof typeof commandHandlers]
      if (handler) {
        handler()
        // 清空输入框和草稿
        setText('')
        clearDraft(threadId)
        requestAnimationFrame(autoResize)
        return
      }
      // 未知命令给出错误提示
      toast.error('未知命令: ' + cmd)
      return
    }

    // B1: planMode 为 true 时，在消息前附加 plan 指令标记
    const finalText = planMode ? `[plan] ${trimmed}` : trimmed
    onSend(finalText)
    // 发送后重置 planMode
    if (planMode) setPlanMode(false)
    // 清空输入框和草稿
    setText('')
    clearDraft(threadId)
    // 重置高度
    requestAnimationFrame(autoResize)
  }, [
    text,
    isSending,
    onSend,
    clearDraft,
    threadId,
    autoResize,
    commandHandlers,
    planMode,
  ])

  /* ===== 斜杠命令建议弹窗 + @提及文件 + 附件列表事件处理 ===== */
  // 选择斜杠命令：B1 选中后立即执行对应操作（不只是替换文本）
  const handlePickSuggest = useCallback(
    (cmd: SlashCommand) => {
      // B1: 检查是否为有即时处理器的命令
      const handler = commandHandlers[cmd.title as keyof typeof commandHandlers]
      if (handler) {
        // 即时命令（/clear, /help, /plan, /summarize）：直接执行操作并清空输入框
        handler()
        // 清空输入框中的 "/xxx" 文本
        const idx = text.lastIndexOf('/')
        const newValue = text.slice(0, idx).trimEnd()
        setText(newValue)
        setDraft(threadId, newValue)
        // 关闭建议弹窗
        setSuggestDismissed(true)
        // 聚焦回输入框并调整高度
        requestAnimationFrame(() => {
          textareaRef.current?.focus()
          autoResize()
        })
        return
      }
      // 非即时命令（/compact, /goal 等）：保留原有行为（替换文本 + toast 反馈）
      const idx = text.lastIndexOf('/')
      const newValue = text.slice(0, idx) + cmd.title + ' '
      setText(newValue)
      setDraft(threadId, newValue)
      // 关闭建议弹窗（标记为手动关闭，防止文本恰好以 "/" 开头时重新弹出）
      setSuggestDismissed(true)
      // I-M-003: 斜杠命令选择后给出 toast 反馈
      toast.info('命令: ' + cmd.title)
      // 聚焦回输入框并调整高度
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        autoResize()
      })
    },
    [text, threadId, setDraft, autoResize, commandHandlers]
  )

  // I-M-004: 选择 @提及文件：移除输入框中的 "@xxx" 文本 + 添加到附件列表
  const handlePickMention = useCallback(
    (file: string) => {
      // 找到最后一个 "@" 的位置，移除 "@xxx" 文本（保留 "@" 之前的内容）
      const idx = text.lastIndexOf('@')
      const newValue = text.slice(0, idx).trimEnd()
      setText(newValue)
      setDraft(threadId, newValue)
      // 添加到附件列表
      setAttachments(prev => [...prev, { name: file, path: file }])
      // 关闭建议弹窗
      setSuggestDismissed(true)
      // toast 反馈
      toast.info('已添加附件: ' + file)
      // 聚焦回输入框并调整高度
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        autoResize()
      })
    },
    [text, threadId, setDraft, autoResize]
  )

  // I-M-005: 附件按钮点击 → 切换附件下拉菜单显隐（不再循环添加 mock 附件）
  const handleAttachClick = useCallback(() => {
    setOpenDropdown(prev => (prev === 'attach' ? null : 'attach'))
  }, [])

  // I-M-005: 文件选择回调 — 遍历 FileList 添加到附件列表
  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      // P1-7: 用户取消文件选择（fileList 为空或 null）时静默返回，不再添加 mock 附件
      if (!files || files.length === 0) {
        // 关闭下拉菜单并重置 input value（允许重复选择同一文件）
        setOpenDropdown(null)
        e.target.value = ''
        return
      }
      const newAtts: { name: string; path: string }[] = []
      for (const f of Array.from(files)) {
        newAtts.push({ name: f.name, path: f.name })
      }
      if (newAtts.length > 0) {
        setAttachments(prev => [...prev, ...newAtts])
        toast.info(`已添加 ${newAtts.length} 个附件`)
      }
      // 关闭下拉菜单
      setOpenDropdown(null)
      // 重置 input value 以允许重复选择同一文件
      e.target.value = ''
    },
    []
  )

  // I-M-005: 文件夹选择回调 — 遍历 FileList 添加到附件列表（webkitdirectory）
  const handleFolderSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      if (files && files.length > 0) {
        const newAtts: { name: string; path: string }[] = []
        // webkitRelativePath 包含文件夹路径，优先使用
        for (const f of Array.from(files)) {
          const path = f.webkitRelativePath || f.name
          newAtts.push({ name: f.name, path })
        }
        if (newAtts.length > 0) {
          setAttachments(prev => [...prev, ...newAtts])
          toast.info(`已添加 ${newAtts.length} 个附件`)
        }
      }
      // 关闭下拉菜单
      setOpenDropdown(null)
      // 重置 input value 以允许重复选择
      e.target.value = ''
    },
    []
  )

  // 移除附件：按索引从列表中删除
  const handleRemoveAttachment = useCallback((index: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== index))
  }, [])

  // 项目下拉菜单切换（提取为 useCallback 保持引用稳定）
  const handleToggleProjectDropdown = useCallback(() => {
    setOpenDropdown(prev => (prev === 'project' ? null : 'project'))
  }, [])

  // 模型下拉菜单切换（提取为 useCallback 保持引用稳定）
  const handleToggleModelDropdown = useCallback(() => {
    setOpenDropdown(prev => (prev === 'model' ? null : 'model'))
  }, [])

  // 选择项目（参数化回调，避免 .map 内联回调包含业务逻辑）
  const handleSelectProject = useCallback((project: string) => {
    setSelectedProject(project)
    setOpenDropdown(null)
  }, [])

  // 选择模型（参数化回调，避免 .map 内联回调包含业务逻辑）
  const handleSelectModel = useCallback((model: string) => {
    setSelectedModel(model)
    setOpenDropdown(null)
  }, [])

  // 斜杠命令按钮点击：在输入框末尾插入 "/"，打开建议弹窗
  const handleSlashClick = useCallback(() => {
    let value = text
    // 如果当前有内容且末尾不是空格，先补一个空格分隔
    if (value && !/\s$/.test(value)) {
      value += ' '
    }
    value += '/'
    setText(value)
    setDraft(threadId, value)
    // 重置关闭状态，允许弹窗显示
    setSuggestDismissed(false)
    // 聚焦输入框并移动光标到末尾
    requestAnimationFrame(() => {
      const textarea = textareaRef.current
      if (!textarea) return
      textarea.focus()
      const len = textarea.value.length
      textarea.setSelectionRange(len, len)
      autoResize()
    })
  }, [text, threadId, setDraft, autoResize])

  // 键盘事件处理
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // ===== 斜杠命令 / @提及文件 建议弹窗的键盘导航 =====
      if (isSuggestOpen) {
        // ↓ 向下选择（循环）
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSuggestActive(
            prev => (prev + 1) % Math.max(suggestItemsCount, 1)
          )
          return
        }
        // ↑ 向上选择（循环）
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSuggestActive(
            prev =>
              (prev - 1 + suggestItemsCount) %
              Math.max(suggestItemsCount, 1)
          )
          return
        }
        // Enter / Tab 确认选择当前项（斜杠命令或文件）
        if (
          (e.key === 'Enter' || e.key === 'Tab') &&
          suggestItemsCount > 0
        ) {
          // I-M-004: 根据触发类型选择斜杠命令或文件
          if (triggerType === 'slash') {
            const cmd = filteredCmds[suggestActive]
            // noUncheckedIndexedAccess 下需检查 undefined
            if (cmd) {
              e.preventDefault()
              handlePickSuggest(cmd)
            }
          } else if (triggerType === 'mention') {
            const file = filteredFiles[suggestActive]
            if (file) {
              e.preventDefault()
              handlePickMention(file)
            }
          }
          return
        }
        // Esc 关闭建议弹窗（不触发中断轮次）
        if (e.key === 'Escape') {
          e.preventDefault()
          setSuggestDismissed(true)
          return
        }
      }
      // Enter 发送，Shift+Enter 换行
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleSend()
        return
      }
      // Esc 中断正在进行的轮次
      if (e.key === 'Escape' && hasActiveTurn) {
        e.preventDefault()
        onCancel?.()
      }
    },
    [
      isSuggestOpen,
      suggestItemsCount,
      triggerType,
      filteredCmds,
      filteredFiles,
      suggestActive,
      handlePickSuggest,
      handlePickMention,
      handleSend,
      hasActiveTurn,
      onCancel,
    ]
  )

  /* ===== 拖拽手柄事件处理 ===== */
  // 鼠标按下：开始拖拽
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    // I-M-006: 动态计算拖拽最小高度 = 当前文本内容的自然高度（避免拖拽时丢失已输入内容）
    const naturalHeight = textareaRef.current?.scrollHeight ?? DRAG_MIN_HEIGHT
    dragMinHeightRef.current = Math.max(DRAG_MIN_HEIGHT, Math.min(naturalHeight, MAX_HEIGHT))
    dragRef.current.dragging = true
    dragRef.current.startY = e.clientY
    dragRef.current.startMaxHeight = dragMaxHeightRef.current
    setIsDragging(true)
    // 防止拖拽时选中文本
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'ns-resize'
  }, [])

  // I-M-007: 双击重置输入框高度到默认值
  // 前端实现：重置 dragMaxHeight 为 MAX_HEIGHT 并 autoResize，语义等价
  const handleDragDoubleClick = useCallback(() => {
    setDragMaxHeight(MAX_HEIGHT)
    requestAnimationFrame(autoResize)
  }, [setDragMaxHeight, autoResize])

  // 拖拽过程监听 document 事件（mousemove/mouseup），避免鼠标移出手柄后失效
  // RAF 节流：mousemove 每秒可触发 60+ 次，直接 setState 会引发 React 高频重渲染。
  // 改为：mousemove 直接操作 DOM（即时反馈），setState 推迟到下一个 RAF 批处理。
  const dragRafIdRef = useRef<number | null>(null)
  const dragPendingHeightRef = useRef<number | null>(null)
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.dragging) return
      // 向上拖增大高度（startY - clientY 为正表示向上移动）
      const dy = dragRef.current.startY - e.clientY
      // I-M-006: 使用动态计算的 dragMinHeightRef 替代固定 DRAG_MIN_HEIGHT
      const newHeight = Math.max(
        dragMinHeightRef.current,
        Math.min(DRAG_MAX_HEIGHT, dragRef.current.startMaxHeight + dy)
      )
      // 直接设置 textarea 高度，避免等待 React 重渲染（即时视觉反馈）
      const textarea = textareaRef.current
      if (textarea) {
        textarea.style.height = `${newHeight}px`
      }
      // 把 setDragMaxHeight 推迟到下一个 RAF —— 同一帧内多次 mousemove 只触发一次 setState
      dragPendingHeightRef.current = newHeight
      if (dragRafIdRef.current === null) {
        dragRafIdRef.current = requestAnimationFrame(() => {
          dragRafIdRef.current = null
          if (dragPendingHeightRef.current !== null) {
            setDragMaxHeight(dragPendingHeightRef.current)
            dragPendingHeightRef.current = null
          }
        })
      }
    }

    const onMouseUp = () => {
      if (!dragRef.current.dragging) return
      dragRef.current.dragging = false
      setIsDragging(false)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      // 拖拽结束时确保最后一次 pending 高度立即提交，避免高度回弹
      if (dragRafIdRef.current !== null) {
        cancelAnimationFrame(dragRafIdRef.current)
        dragRafIdRef.current = null
      }
      if (dragPendingHeightRef.current !== null) {
        setDragMaxHeight(dragPendingHeightRef.current)
        dragPendingHeightRef.current = null
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      // 组件卸载时取消未完成的 RAF，避免对已卸载组件 setState
      if (dragRafIdRef.current !== null) {
        cancelAnimationFrame(dragRafIdRef.current)
        dragRafIdRef.current = null
      }
    }
  }, [setDragMaxHeight])

  // 是否可以发送（有文本且不在发送中）
  const canSend = text.trim() !== '' && !isSending
  // 当前字符数（用于字符计数器显示）
  const charCount = text.length
  // 状态文案（就绪/运行中/错误）
  const currentStatus = status ?? 'ready'
  const statusLabel =
    currentStatus === 'running'
      ? '运行中'
      : currentStatus === 'error'
        ? '错误'
        : '就绪'
  // 账户名（带默认值）
  const displayAccount = accountName ?? DEFAULT_ACCOUNT_NAME
  // 安全缓冲是否低于警告阈值（低于时 stats-bar 中 safetyBuffer 项显示 warn 色）
  const isSafetyBufferLow =
    chatStats.safetyBufferPercent < SAFETY_BUFFER_WARN_THRESHOLD

  return (
    <div
      data-area="composer"
      className={cn(
        'group relative min-w-0',
        // welcomeMode：去除顶边框、背景透明、内边距归零（对齐 .view-chat.welcome-mode .composer）
        // 非 welcomeMode：保留顶边框、渐变背景、内边距
        welcomeMode
          ? 'border-t-0 bg-transparent p-0'
          // M-A-001: 600px 断点下 padding 响应式缩小（10px 12px 12px → px-3 pb-3 pt-2.5）
          : 'border-t border-[var(--border)] bg-gradient-to-b from-[var(--bg-elev)] to-[var(--bg)] px-6 pb-[18px] pt-3.5 max-[600px]:px-3 max-[600px]:pb-3 max-[600px]:pt-2.5',
        className
      )}
    >
      {/* 顶部渐变分隔线（参考 prototype ::before）— welcomeMode 下隐藏 */}
      {/* 渐变区间 30%-70% 纯色（平顶），对齐原型 linear-gradient(90deg, transparent, var(--border-strong) 30%, var(--border-strong) 70%, transparent) */}
      {!welcomeMode && (
        <div
          className="absolute -top-px left-0 right-0 h-px"
          style={{ background: 'linear-gradient(90deg, transparent, var(--border-strong) 30%, var(--border-strong) 70%, transparent)' }}
        />
      )}

      {/* 拖拽手柄（参考 .composer-drag-handle）— 位于 composer 顶部，拖拽调整 textarea 高度 */}
      <div
        role="separator"
        aria-orientation="horizontal"
        title="拖拽调整高度（双击重置）"
        onMouseDown={handleDragStart}
        onDoubleClick={handleDragDoubleClick}
        className={cn(
          // 拖拽手柄垂直位置：top:-5px（对齐原型 .composer-drag-handle { top: -5px }）
          'absolute -top-[5px] left-0 right-0 z-10 flex h-2.5 cursor-ns-resize items-center justify-center',
          'transition-opacity duration-200',
          // hover 时显示（group-hover），拖拽中始终显示
          isDragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        )}
      >
        {/* 可见的拖拽指示条（4px 高度） */}
        <span
          className={cn(
            'block h-[3px] w-9 rounded-[2px] transition-colors duration-150',
            isDragging
              ? 'bg-[var(--accent)]'
              : 'bg-[var(--border-strong)] group-hover:bg-[var(--accent)]'
          )}
        />
      </div>

      {/* 输入框容器（参考 .composer-box，position: relative 用于定位 suggest-pop） */}
      <div
        className={cn(
          // C14: welcomeMode 圆角 12px + 较浅边框 var(--border) + 外阴影
          //      非 welcomeMode 圆角 10px + border-strong 边框 + 内阴影（对齐 .composer-box / .view-chat.welcome-mode .composer-box）
          'group/composer relative mx-auto border bg-[var(--bg-elev-2)] transition-all duration-200',
          welcomeMode
            ? 'rounded-[12px] border-[var(--border)] shadow-[0_2px_12px_rgba(0,0,0,0.08)]'
            : 'rounded-[10px] border-[var(--border-strong)] shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]',
          // C14: welcomeMode 时 max-w-[720px]，否则 max-w-[820px]
          welcomeMode ? 'max-w-[720px]' : 'max-w-[820px]',
          // 聚焦时使用 accent 边框、发光、背景提升到 bg-elev-3（对齐 .composer-box:focus-within）
          'focus-within:border-[var(--accent-dim)] focus-within:bg-[var(--bg-elev-3)] focus-within:shadow-[0_0_0_3px_var(--accent-glow),0_8px_24px_rgba(0,229,199,0.08)]'
        )}
      >
        {/* C22: composer-box 顶部聚焦渐变线（对齐 .composer-box::before）
            focus-within 时显示，left/right 10% 对齐原型，accent-dim 渐变 */}
        <div className="pointer-events-none absolute -top-px left-[10%] right-[10%] h-px bg-gradient-to-r from-transparent via-[var(--accent-dim)] to-transparent opacity-0 transition-opacity duration-300 group-focus-within/composer:opacity-100" />
        {/* I-M-004: 建议弹窗（参考 .suggest-pop）— 斜杠命令 / @提及文件，绝对定位在 composer-box 上方 */}
        {isSuggestOpen && (
          <div
            role="listbox"
            aria-label={triggerType === 'slash' ? '斜杠命令' : '项目文件'}
            aria-activedescendant={suggestItemsCount > 0 ? `suggest-item-${suggestActive}` : undefined}
            className="absolute bottom-full left-0 right-0 z-[var(--z-dropdown)] mb-1.5 max-h-[240px] overflow-hidden rounded-[9px] border border-[var(--border-strong)] bg-[var(--bg-elev)] shadow-[0_-10px_30px_rgba(0,0,0,0.4)]"
          >
            {/* 弹窗标题栏 */}
            <div className="border-b border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-faint)]">
              {triggerType === 'slash' ? '斜杠命令' : '项目文件'}
            </div>
            {/* 列表（可滚动区域） */}
            <div className="max-h-[210px] overflow-y-auto">
              {suggestItemsCount === 0 ? (
                // 无匹配项时的空状态提示
                <div className="px-3.5 py-3.5 text-center text-xs text-[var(--text-faint)]">
                  无匹配项
                </div>
              ) : triggerType === 'slash' ? (
                // ===== 斜杠命令列表 =====
                filteredCmds.map((cmd, i) => (
                  <button
                    key={cmd.title}
                    id={`suggest-item-${i}`}
                    role="option"
                    aria-selected={i === suggestActive}
                    // 仅给当前激活项绑定 ref，用于键盘导航时滚动到可视区域
                    ref={i === suggestActive ? activeItemRef : undefined}
                    type="button"
                    onClick={() => handlePickSuggest(cmd)}
                    // 鼠标悬停时更新激活项，确保点击和键盘导航一致
                    onMouseEnter={() => setSuggestActive(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                      // 激活项：高亮背景 + 左侧 accent 竖条
                      i === suggestActive
                        ? 'bg-[var(--bg-elev-2)] shadow-[inset_2px_0_0_var(--accent)]'
                        : ''
                    )}
                  >
                    {/* 命令图标（字母标识，参考 .suggest-icon） */}
                    <span
                      className={cn(
                        'flex size-[22px] flex-shrink-0 items-center justify-center rounded-[5px] border bg-[var(--bg-elev-2)] font-mono text-[11px] font-semibold',
                        i === suggestActive
                          ? 'border-[var(--accent-glow)] text-[var(--accent)]'
                          : 'border-[var(--border)] text-[var(--text-dim)]'
                      )}
                    >
                      {cmd.icon}
                    </span>
                    {/* 命令名 + 描述（参考 .suggest-main） */}
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12.5px] text-[var(--text)]">
                        {cmd.title}
                      </span>
                      <span className="mt-0.5 block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10.5px] text-[var(--text-faint)]">
                        {cmd.sub}
                      </span>
                    </span>
                  </button>
                ))
              ) : (
                // ===== I-M-004: @提及文件列表 =====
                filteredFiles.map((file, i) => (
                  <button
                    key={file}
                    id={`suggest-item-${i}`}
                    role="option"
                    aria-selected={i === suggestActive}
                    ref={i === suggestActive ? activeItemRef : undefined}
                    type="button"
                    onClick={() => handlePickMention(file)}
                    onMouseEnter={() => setSuggestActive(i)}
                    className={cn(
                      'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                      i === suggestActive
                        ? 'bg-[var(--bg-elev-2)] shadow-[inset_2px_0_0_var(--accent)]'
                        : ''
                    )}
                  >
                    {/* 文件图标 */}
                    <span
                      className={cn(
                        'flex size-[22px] flex-shrink-0 items-center justify-center rounded-[5px] border bg-[var(--bg-elev-2)]',
                        i === suggestActive
                          ? 'border-[var(--accent-glow)] text-[var(--accent)]'
                          : 'border-[var(--border)] text-[var(--text-dim)]'
                      )}
                    >
                      <File className="size-3" />
                    </span>
                    {/* 文件路径 */}
                    <span className="min-w-0 flex-1">
                      <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px] text-[var(--text)]">
                        {file}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        )}

        {/* 附件列表（参考 .composer-attachments）— 位于 textarea 上方，无附件时不显示 */}
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-2.5 pb-1.5">
            {attachments.map((att, i) => (
              <span
                key={`${att.name}-${i}`}
                className="inline-flex items-center gap-1.5 rounded-[5px] border border-[var(--border-strong)] bg-[var(--bg-elev-2)] px-2 py-0.5 font-mono text-[11px] text-[var(--text-dim)]"
              >
                {/* 文件图标 */}
                <File className="size-2.5 opacity-70" />
                {/* 文件名 */}
                <span>{att.name}</span>
                {/* 移除按钮（×） */}
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(i)}
                  aria-label={`移除附件 ${att.name}`}
                  className="flex size-[13px] items-center justify-center rounded-[3px] border-none bg-transparent text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-elev)] hover:text-[var(--error)]"
                >
                  <X className="size-2" />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 文本输入区 */}
        {/* data-slot="composer-input"：供 App.css 中 .is-minimal [data-slot='composer-input'] { font-size:14px } 规则匹配 */}
        <textarea
          data-slot="composer-input"
          ref={textareaRef}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={isSending}
          placeholder={PLACEHOLDER}
          rows={1}
          aria-label="消息输入框"
          className={cn(
            'block w-full resize-none border-none bg-transparent px-3.5 py-3',
            // M-B-002: 480px 断点下 textarea padding 压缩为 9px 8px（对齐原型 prototype.html 第 5036 行 .composer-input { padding:9px 8px }）
            'max-[480px]:px-2 max-[480px]:py-[9px]',
            // C23: textarea 行高 1.5（对齐原型 .composer-input { line-height: 1.5 }）
            'font-sans text-sm leading-normal text-[var(--text)]',
            'placeholder:text-[var(--text-faint)] focus:outline-none focus:ring-0',
            'disabled:opacity-50'
          )}
          style={{ minHeight: MIN_HEIGHT, maxHeight: dragMaxHeight }}
        />

        {/* 底部工具栏（参考 .composer-bar） */}
        <div
          className={cn(
            // M-A-002: 600px 断点下 gap 与 padding 响应式（gap:4px padding:6px 8px）
            // M-A-009: 480px 断点下 padding 进一步压缩（6px 6px）
            'flex items-center gap-2 rounded-b-[9px] border-t border-[var(--border-strong)] px-2.5 min-h-[46px] max-[600px]:gap-1 max-[600px]:px-2 max-[600px]:py-1.5 max-[480px]:px-1.5 max-[480px]:py-1.5',
            // welcomeMode: padding 6px 10px；非 welcomeMode: 8px 10px（对齐 .view-chat.welcome-mode .composer-bar / .composer-bar）
            welcomeMode ? 'py-1.5' : 'py-2'
          )}
        >
          {/* 工具按钮区（参考 .composer-tools）— 附件按钮 + 斜杠命令按钮 */}
          {/* M-A-005: 600px 断点下隐藏工具按钮区（对齐原型 .composer-tools { display:none }） */}
          <div className="flex flex-shrink-0 items-center gap-1 max-[600px]:hidden">
            {/* I-M-005: 附件按钮 — 点击弹出下拉菜单（选择文件/选择文件夹） */}
            <div className="relative">
              <button
                type="button"
                onClick={handleAttachClick}
                disabled={isSending}
                aria-label="附加文件"
                title="附加文件"
                className={cn(
                  'flex size-[30px] items-center justify-center rounded-[5px] border-none transition-colors',
                  openDropdown === 'attach'
                    ? 'bg-[var(--bg-elev-2)] text-[var(--text)]'
                    : 'bg-transparent text-[var(--text-faint)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]'
                )}
              >
                <Paperclip className="size-3.5" />
              </button>
              {/* I-M-005: 附件下拉菜单（选择文件 / 选择文件夹） */}
              {openDropdown === 'attach' && (
                <>
                  {/* 点击外部关闭的透明遮罩 */}
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setOpenDropdown(null)}
                  />
                  <div className="absolute bottom-full left-0 mb-1 z-50 flex min-w-[160px] flex-col rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1 shadow-lg">
                    {/* 选择文件 */}
                    <button
                      type="button"
                      onClick={() => {
                        fileInputRef.current?.click()
                      }}
                      className="flex items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--bg-elev-2)]"
                    >
                      <File className="size-3.5 flex-shrink-0 opacity-70" />
                      <span>选择文件</span>
                    </button>
                    {/* 选择文件夹 */}
                    <button
                      type="button"
                      onClick={() => {
                        folderInputRef.current?.click()
                      }}
                      className="flex items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs text-[var(--text)] transition-colors hover:bg-[var(--bg-elev-2)]"
                    >
                      <Folder className="size-3.5 flex-shrink-0 opacity-70" />
                      <span>选择文件夹</span>
                    </button>
                  </div>
                </>
              )}
            </div>
            {/* I-M-005: 隐藏的文件/文件夹选择 input */}
            <input
              type="file"
              multiple
              ref={fileInputRef}
              className="hidden"
              onChange={handleFileSelect}
            />
            <input
              type="file"
              ref={folderInputRef}
              className="hidden"
              onChange={handleFolderSelect}
              {...({ webkitdirectory: '' } as React.HTMLAttributes<HTMLInputElement>)}
            />
            {/* 斜杠命令按钮：点击在输入框插入 "/"，弹窗激活时高亮（参考 .composer-tool-btn.active） */}
            <button
              type="button"
              onClick={handleSlashClick}
              aria-label="斜杠命令"
              title="斜杠命令 (/)"
              className={cn(
                'flex size-[30px] items-center justify-center rounded-[5px] border-none transition-colors',
                isSuggestOpen && triggerType === 'slash'
                  ? 'bg-[var(--accent-glow)] text-[var(--accent)]'
                  : 'bg-transparent text-[var(--text-faint)] hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]'
              )}
            >
              <Slash className="size-3.5" />
            </button>
          </div>

          {/* 键盘快捷键提示 — 对齐原型 .composer-hint：
              ⏎ 发送 · ⇧⏎ 换行 · ⌘P 命令面板 · Esc 中断 */}
          {/* M-A-003: 600px 断点下隐藏快捷键提示（对齐原型 .composer-hint { display:none }） */}
          {/* M-B-001: 900px 断点下隐藏快捷键提示（对齐原型 prototype.html 第 5005 行 .composer-hint { display:none }） */}
          <div className="flex items-center font-mono text-[10.5px] text-[var(--text-faint)] max-[900px]:hidden">
            <kbd className="rounded-[3px] border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px text-[10px] leading-[1.4]">
              ⏎
            </kbd>
            <span className="mx-1">发送</span>
            <span className="text-[var(--border-strong)]">·</span>
            <kbd className="ml-1 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px text-[10px]">
              ⇧⏎
            </kbd>
            <span className="mx-1">换行</span>
            <span className="text-[var(--border-strong)]">·</span>
            <kbd className="ml-1 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px text-[10px]">
              ⌘P
            </kbd>
            <span className="mx-1">命令面板</span>
            {/* Esc 中断仅在活跃轮次时显示（无活跃轮次时 Esc 无意义） */}
            {hasActiveTurn && (
              <>
                <span className="text-[var(--border-strong)]">·</span>
                <kbd className="ml-1 rounded border border-[var(--border-strong)] bg-[var(--bg)] px-[5px] py-px text-[10px]">
                  Esc
                </kbd>
                <span className="mx-1">中断</span>
              </>
            )}
          </div>

          {/* 字符计数器（参考 .char-count）— 实时统计 textarea 字符数 */}
          {/* M-A-010: 480px 断点下隐藏字符计数器（对齐原型 .char-count { display:none }） */}
          <span
            className={cn(
              'ml-auto font-mono text-[10px] leading-none transition-colors duration-200 max-[480px]:hidden',
              // 超过警告阈值时显示警告色
              charCount > CHAR_WARN_THRESHOLD
                ? 'text-[var(--warn)]'
                : 'text-[var(--text-faint)]'
            )}
          >
            {charCount > CHAR_WARN_THRESHOLD
              ? `${charCount}/${CHAR_LIMIT}`
              : `${charCount}`}
          </span>

          {/* B2: token 计数显示（输入框右下角，tokenCount > 0 时显示） */}
          {tokenCount > 0 && (
            <span className="text-[10px] text-[var(--text-faint)] font-mono leading-none whitespace-nowrap max-[480px]:hidden">
              {tokenCount} tokens
            </span>
          )}

          {/* 发送/中断按钮 */}
          <div className="flex-shrink-0">
            {hasActiveTurn ? (
              // 中断按钮（红色，方形停止图标）
              // C25: 尺寸 34px、圆角 8px（对齐原型 .stop-gen-btn { width:34px; height:34px; border-radius:8px }）
              <button
                type="button"
                onClick={onCancel}
                aria-label="中断生成"
                title="中断生成"
                className={cn(
                  'flex size-[34px] items-center justify-center rounded-lg',
                  'border-none bg-[var(--error)] text-white transition-opacity',
                  'hover:opacity-85'
                )}
              >
                <Square className="size-3.5" />
              </button>
            ) : (
              // 发送按钮（accent 色，上箭头图标）
              <button
                type="button"
                onClick={handleSend}
                disabled={!canSend}
                aria-label="发送消息"
                title="发送消息"
                className={cn(
                  // M-A-011: 480px 断点下发送按钮放大至 34px（对齐原型 .send-btn { width:34px; height:34px }）
                  'flex size-[30px] items-center justify-center rounded-[7px] max-[480px]:size-[34px]',
                  'border-none transition-all',
                  canSend
                    ? 'bg-[var(--accent)] text-[#001814] hover:shadow-[0_0_14px_var(--accent-glow)]'
                    : 'cursor-not-allowed bg-[var(--border-strong)] text-[var(--text-faint)] opacity-35'
                )}
              >
                <ArrowUp className="size-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 项目栏（参考 .composer-project-bar）— 位于 textarea/composer-box 下方，包含本地/项目/模型选择 */}
      {/* C17: 背景/bg-elev-2、圆角 12px、内边距 7px 10px、无边框（对齐原型） */}
      {/* C18: 字体改为 sans（对齐原型 .composer-project-bar { font-family: var(--sans) }） */}
      <div
        className={cn(
          // M-A-007: 600px 断点下隐藏项目栏（对齐原型 .composer-project-bar { display:none }）
          'mx-auto mt-1.5 flex items-center gap-1 rounded-xl border-0 bg-[var(--bg-elev-2)] px-2.5 py-[7px] text-[11px] text-[var(--text-faint)] max-[600px]:hidden',
          // C14: welcomeMode 时 max-w-[720px]，否则 max-w-[820px]
          welcomeMode ? 'max-w-[720px]' : 'max-w-[820px]'
        )}
      >
        {/* 本地标识（非交互，参考 #cpbLocalSelect pointer-events: none） */}
        <div className="inline-flex items-center gap-1 opacity-85">
          <Monitor className="size-3 opacity-70" />
          <span>本地</span>
        </div>

        {/* 项目选择下拉（.cpb-select） */}
        <div className="relative inline-flex">
          <button
            type="button"
            onClick={handleToggleProjectDropdown}
            className="inline-flex min-w-0 items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-elev-3)] hover:text-[var(--text-dim)]"
          >
            <Folder className="size-3 flex-shrink-0 opacity-70" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {selectedProject}
            </span>
            <ChevronDown className="size-2.5 flex-shrink-0 opacity-50" />
          </button>

          {/* 项目下拉菜单（向上弹出） */}
          {openDropdown === 'project' && (
            <>
              {/* 点击外部关闭的透明遮罩 */}
              <div
                className="fixed inset-0 z-40"
                onClick={() => setOpenDropdown(null)}
              />
              <div className="absolute bottom-full left-0 mb-1 z-50 flex min-w-[200px] flex-col rounded-md border border-[var(--border)] bg-[var(--bg-elev-2)] p-1 shadow-lg">
                {PROJECT_OPTIONS.map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => handleSelectProject(opt)}
                    className={cn(
                      'flex items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors',
                      opt === selectedProject
                        ? 'text-[var(--accent)]'
                        : 'text-[var(--text)] hover:bg-[var(--bg-elev-3)]'
                    )}
                  >
                    <Folder className="size-3.5 flex-shrink-0 opacity-70" />
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                      {opt}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* 模型选择下拉（.cpb-select.model-select）— 靠右显示 */}
        <div className="relative ml-auto inline-flex">
          <button
            type="button"
            onClick={handleToggleModelDropdown}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--bg-elev-3)] hover:text-[var(--text-dim)]"
          >
            {/* 模型状态指示点 */}
            <span className="size-1.5 flex-shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent)]" />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
              {selectedModel}
            </span>
            <ChevronDown className="size-2.5 flex-shrink-0 opacity-50" />
          </button>

          {/* 模型下拉菜单（向上弹出） */}
          {openDropdown === 'model' && (
            <>
              <div
                className="fixed inset-0 z-40"
                onClick={() => setOpenDropdown(null)}
              />
              <div className="absolute bottom-full right-0 mb-1 z-50 flex min-w-[220px] flex-col rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev)] p-1.5 shadow-lg">
                {MODEL_OPTIONS.map(opt => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => handleSelectModel(opt)}
                    className={cn(
                      'flex items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors',
                      opt === selectedModel
                        ? 'bg-[var(--bg-elev-2)] text-[var(--accent)]'
                        : 'text-[var(--text)] hover:bg-[var(--bg-elev-2)]'
                    )}
                  >
                    <span className="size-1.5 flex-shrink-0 rounded-full bg-[var(--accent)] shadow-[0_0_6px_var(--accent-glow)]" />
                    <span className="font-mono text-[11.5px] font-semibold">
                      {opt}
                    </span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      {/* 统计栏（参考 .composer-stats-bar）— 位于项目栏下方，显示指标项：
          状态 · 消息数 · 轮次 · Token · 速率 · 账户 · 速率限制 · [安全缓冲] · [模型重路由]
          C15: welcomeMode 下隐藏（对齐 .view-chat.welcome-mode .composer-stats-bar { display:none }）
          C19: 移除上边框（对齐原型 .composer-stats-bar 无 border）
          C20: 安全缓冲项仅在低于阈值时显示；模型重路由项仅在非空时显示（连同分隔符） */}
      <div
        className={cn(
          'mx-auto flex max-w-[820px] items-center gap-1.5 px-2.5 py-1 font-mono text-[10px] text-[var(--text-faint)]',
          // M-B-008: 防换行 + 弹性收缩属性（对齐原型 prototype.html 第 4181-4185 行 .composer-stats-bar）
          //   line-height:1 → leading-none
          //   flex-shrink:0 → flex-shrink-0
          //   min-width:0 → min-w-0
          //   overflow:hidden → overflow-hidden
          //   white-space:nowrap → whitespace-nowrap
          'min-w-0 flex-shrink-0 overflow-hidden whitespace-nowrap leading-none',
          // C15: welcomeMode 下整个统计栏隐藏
          welcomeMode && 'hidden'
        )}
      >
        {/* 1. 状态 */}
        <span className="font-semibold text-[var(--text-dim)]">
          {statusLabel}
        </span>
        <span className="text-[var(--border-strong)]">·</span>
        {/* 2. 消息数 */}
        <span>
          {messageCount} msgs
        </span>
        <span className="text-[var(--border-strong)]">·</span>
        {/* 3. 轮次数 */}
        <span>
          {turnCount} turns
        </span>
        <span className="text-[var(--border-strong)]">·</span>
        {/* 4. Token 用量 */}
        <span>
          Token{' '}
          <span className="font-semibold text-[var(--text-dim)]">
            {tokenCount} / 200k
          </span>
        </span>
        <span className="text-[var(--border-strong)]">·</span>
        {/* 5. 当前 token 速率（参考原型 #csbRate） */}
        <span>
          <span className="font-semibold text-[var(--text-dim)]">
            {chatStats.tokenRate}
          </span>
        </span>
        <span className="text-[var(--border-strong)]">·</span>
        {/* 6. 账户 */}
        <span>{displayAccount}</span>
        <span className="text-[var(--border-strong)]">·</span>
        {/* 7. 速率限制配额（accent 色高亮，参考原型 #csbRateLimit） */}
        <span className="text-[var(--accent)]">
          <span className="font-semibold">{chatStats.rateLimit}</span>
        </span>
        {/* 8. 安全缓冲百分比 — C20: 仅在低于阈值（<50%）时显示，连同前置分隔符 */}
        {isSafetyBufferLow && (
          <>
            <span className="text-[var(--border-strong)]">·</span>
            <span className="font-semibold text-[var(--warn)]">
              buffer {chatStats.safetyBufferPercent}%
            </span>
          </>
        )}
        {/* 9. 模型重路由指示 — C20: 仅在 modelReroute 非空时显示，连同前置分隔符 */}
        {chatStats.modelReroute !== '' && (
          <>
            <span className="text-[var(--border-strong)]">·</span>
            <span className="font-semibold text-[var(--warn)]">
              {chatStats.modelReroute}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
