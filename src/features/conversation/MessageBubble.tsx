/**
 * MessageBubble — 单条消息渲染
 *
 * 对应 prototype.html 的 `.msg` 消息行结构。
 * 根据消息角色（user / assistant / system）和内容类型
 * （text / tool_call / file_change / thinking / approval / plan）
 * 渲染不同的视觉样式：
 *
 * - user 消息：无头像、无角色标签，气泡背景为 --msg-bubble-user
 * - assistant 消息：显示 "C" 图标头像、角色标签，气泡背景透明
 * - tool_call 消息：渲染 ToolCard 可折叠卡片
 * - file_change 消息：渲染 FileChangeCard diff 卡片
 * - thinking/reasoning 消息：渲染 ReasoningBlock 可折叠面板
 * - approval 消息：渲染 InlineApprovalCard 审批卡片
 * - 流式消息（isStreaming）：末尾显示 StreamingCursor
 *
 * Markdown 渲染：使用 react-markdown + remark-gfm + rehype-highlight，
 * 支持代码块语法高亮、表格、列表、链接等富文本格式。
 *
 * 参考样式：prototype.html `.msg` / `.msg-bubble-user` / `.msg-avatar`
 */

import { memo, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
// 按需导入 highlight.js 语言定义（而非默认注册 35+ 语言的 common 预设）
// 仅注册项目实际高频使用的 7 种语言，将 vendor-markdown chunk 从 ~300KB 降至 ~80KB
import typescript from 'highlight.js/lib/languages/typescript'
import javascript from 'highlight.js/lib/languages/javascript'
import rust from 'highlight.js/lib/languages/rust'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import type {
  Message,
  MessageRole,
} from '@/lib/codex/types'
import { cn } from '@/lib/utils'
import { ToolCard } from './ToolCard'
import { ReasoningBlock } from './ReasoningBlock'
import { FileChangeCard } from './FileChangeCard'
import { InlineApprovalCard } from './InlineApprovalCard'
import { CodeBlock } from './CodeBlock'
import { MessageActions } from './MessageActions'
import { StreamingCursor } from './StreamingCursor'

/**
 * rehype-highlight 配置：仅注册项目高频语言。
 *
 * 默认 common 预设会注册 35+ 语言（额外注入 ~100-150KB gzip），
 * 实际项目仅需 typescript/javascript/rust/json/bash/markdown/python。
 * 未注册的语言会以纯文本显示（不影响功能，仅无语法高亮）。
 */
const rehypeHighlightOptions = {
  languages: {
    typescript,
    javascript,
    rust,
    json,
    bash,
    markdown,
    python,
  },
} as const

/** 角色标签文本映射 */
const ROLE_LABEL: Record<Exclude<MessageRole, 'system'>, string> = {
  user: '你',
  assistant: 'codex',
}

export interface MessageBubbleProps {
  /** 消息对象 */
  message: Message
  /** 是否为连续的 assistant 消息（前一条也是 assistant，此时隐藏头像） */
  isContinuation?: boolean
  /** 可选的模型名（显示在角色标签中） */
  modelName?: string | undefined
  /** 审批操作回调（内联审批卡片用） */
  onApprovalAction?:
    | ((
        requestId: string,
        action: 'approve' | 'reject' | 'whitelist'
      ) => void)
    | undefined
  /** I-M-008: 重新生成回调（assistant 消息 hover 操作栏的重新生成按钮触发）。
   *  接收 messageId 参数，避免父组件内联箭头函数破坏 memo。 */
  onRegenerate?: ((messageId: string) => void) | undefined
  /** P2-8: 当前反馈状态（'up' 点赞 / 'down' 踩 / null 无反馈，仅 assistant 消息） */
  feedback?: 'up' | 'down' | null
  /** P2-8: 反馈回调（点击点赞/踩按钮时触发，仅 assistant 消息） */
  onFeedback?: (type: 'up' | 'down') => void
  /** P2-9: 用户消息编辑回调（双击编辑保存时触发，仅 user 消息） */
  onEdit?: (messageId: string, newText: string) => void
  className?: string
}

/**
 * react-markdown 的 code 组件渲染器。
 *
 * 将 Markdown 中的代码块（```language）渲染为 CodeBlock 组件，
 * 行内代码（`code`）保持默认样式。
 */
function markdownCodeRenderer({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLElement> & {
  children?: React.ReactNode
}) {
  // 提取语言类名（格式：language-xxx）
  const match = /language-(\w+)/.exec(className ?? '')
  const language = match?.[1] ?? undefined

  // 判断是代码块还是行内代码
  // react-markdown 中 code 组件既处理行内代码也处理代码块
  // 代码块的外层会有 pre 标签包裹，且 children 包含换行
  const text = String(children ?? '').replace(/\n$/, '')

  if (language !== undefined || text.includes('\n')) {
    // 代码块：使用 CodeBlock 组件
    return (
      <CodeBlock code={text} language={language} />
    )
  }

  // 行内代码：保持默认样式
  return (
    <code
      className="rounded border border-[var(--border)] bg-[var(--bg-elev-2)] px-1.5 py-px font-mono text-[12.5px] text-[var(--accent)]"
      {...props}
    >
      {children}
    </code>
  )
}

/**
 * react-markdown 的 pre 组件渲染器。
 *
 * 覆盖默认的 <pre> 标签，避免与 CodeBlock 的外层 div 嵌套冲突。
 * 直接渲染 children（CodeBlock 组件自带外层容器）。
 */
function markdownPreRenderer({
  children,
}: React.HTMLAttributes<HTMLElement>) {
  return <>{children}</>
}

/**
 * 单条消息气泡组件。
 *
 * 使用 memo 优化性能：消息列表很长时，单条消息更新不会触发整列表重渲染。
 */
function MessageBubbleComponent({
  message,
  isContinuation = false,
  modelName,
  onApprovalAction,
  onRegenerate,
  feedback,
  onFeedback,
  onEdit,
  className,
}: MessageBubbleProps) {
  const isUser = message.role === 'user'

  // P2-9: 用户消息编辑态管理
  const [isEditing, setIsEditing] = useState(false)
  // 编辑文本（进入编辑态时初始化为消息原文）
  const [editText, setEditText] = useState('')

  // P2-9: 保存编辑（调用 onEdit 回调并退出编辑态）
  const handleSaveEdit = () => {
    onEdit?.(message.id, editText)
    setIsEditing(false)
  }

  // P2-9: 取消编辑（仅退出编辑态，不调用回调）
  const handleCancelEdit = () => {
    setIsEditing(false)
  }

  // P2-9: 编辑态键盘快捷键（Enter 保存，Escape 取消，Shift+Enter 换行）
  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSaveEdit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      handleCancelEdit()
    }
  }

  // P2-9: 进入编辑态（初始化编辑文本为消息原文）
  const handleStartEdit = () => {
    setEditText(message.text)
    setIsEditing(true)
  }

  // M2: tool_call / tool_result / file_change / approval 等非文本类型消息
  // 不显示头像和角色标签（对齐原型 .msg-tool { gap:0 } 无头像无名字）。
  // 这些消息内容对齐到 Agent 消息（margin-left:40px，与 continuation 的 ml-10 一致）。
  const isToolLikeMessage =
    message.content === 'tool_call' ||
    message.content === 'tool_result' ||
    message.content === 'file_change' ||
    message.content === 'approval'
  // 实际是否隐藏头像：isContinuation 或 工具类消息
  const hideAvatar = isContinuation || isToolLikeMessage

  // 时间戳格式化（仅在 timestamp 变化时重算，避免每次渲染都创建 Date 对象和选项字面量）
  const formattedTime = useMemo(
    () =>
      new Date(message.timestamp).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    [message.timestamp]
  )

  // ---- 渲染消息内容（根据 content 类型分发） ----
  const renderContent = () => {
    // 工具调用卡片
    if (
      (message.content === 'tool_call' || message.content === 'tool_result') &&
      message.toolCall
    ) {
      return <ToolCard toolCall={message.toolCall} />
    }

    // 文件变更卡片
    if (message.content === 'file_change' && message.fileChange) {
      return <FileChangeCard fileChange={message.fileChange} />
    }

    // 推理摘要块
    if (
      (message.content === 'thinking' || message.content === 'reasoning') &&
      message.reasoning
    ) {
      return <ReasoningBlock reasoning={message.reasoning} />
    }

    // 内联审批卡片
    if (message.content === 'approval' && message.approval) {
      return (
        <InlineApprovalCard
          approval={message.approval}
          onAction={onApprovalAction}
        />
      )
    }

    // 默认：文本内容（用户消息用纯文本，助手消息用 Markdown）
    if (isUser) {
      return (
        <div className="text-sm leading-[1.65] text-[var(--text)]">
          {message.text}
        </div>
      )
    }

    // 助手消息：使用 react-markdown 渲染
    return (
      <div className="text-sm leading-[1.65] text-[var(--text)]">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[[rehypeHighlight, rehypeHighlightOptions]]}
          components={{
            code: markdownCodeRenderer,
            pre: markdownPreRenderer,
          }}
        >
          {message.text}
        </ReactMarkdown>
        {/* 流式输出时显示光标 */}
        {message.isStreaming === true && <StreamingCursor />}
      </div>
    )
  }

  // ---- 用户消息：无头像、无角色标签，气泡有背景色 ----
  if (isUser) {
    return (
      // M3: 消息进入动画（对齐原型 .enter-anim { animation:fadeUp 0.3s ease both }）
      // M3: 组件层补充 animation-fill-mode:both（App.css 由其他子代理负责，此处确保 both 生效）
      // P2-9: 用户消息双击进入编辑态（仅当 onEdit 存在时启用）
      <div
        className={cn('group flex flex-col enter-anim', className)}
        style={{ animationFillMode: 'both' }}
        onDoubleClick={onEdit ? handleStartEdit : undefined}
      >
        {isEditing ? (
          // P2-9: 编辑态 — 渲染 textarea + 保存/取消按钮
          <div className="rounded-[12px] bg-[var(--msg-bubble-user)] px-3.5 py-2.5">
            <textarea
              value={editText}
              onChange={e => setEditText(e.target.value)}
              onKeyDown={handleEditKeyDown}
              autoFocus
              rows={3}
              className="w-full resize-none rounded border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1.5 text-sm leading-[1.65] text-[var(--text)] outline-none focus:border-[var(--accent)]"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelEdit}
                className="rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-elev-2)]"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSaveEdit}
                className="rounded-md bg-[var(--accent)] px-3 py-1 text-xs font-semibold text-[#001814] transition-colors hover:bg-[var(--accent-dim)]"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* 用户消息气泡：四角统一圆角 12px（M9: 移除 rounded-br-sm，对齐原型 .msg-content border-radius:12px） */}
            {/* data-slot="message-bubble"：供 App.css 中 .is-minimal [data-slot='message-bubble'] { padding:8px 10px } 规则匹配 */}
            <div data-slot="message-bubble" className="rounded-[12px] bg-[var(--msg-bubble-user)] px-3.5 py-2.5">
              {renderContent()}
            </div>
            {/* hover 时显示操作栏 */}
            <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100">
              <MessageActions text={message.text} />
            </div>
          </>
        )}
      </div>
    )
  }

  // ---- 助手消息：有头像、有角色标签，气泡背景透明 ----
  return (
    // M3: 消息进入动画（对齐原型 .enter-anim { animation:fadeUp 0.3s ease both }）
    // M3: 组件层补充 animation-fill-mode:both（App.css 由其他子代理负责，此处确保 both 生效）
    <div
      data-area="message"
      className={cn('group flex gap-3.5 enter-anim', hideAvatar && 'gap-0', className)}
      style={{ animationFillMode: 'both' }}
    >
      {/* 头像：连续消息或工具类消息时隐藏（M2: tool_call 等不显示头像） */}
      {!hideAvatar && (
        <div
          className={cn(
            'flex size-[26px] flex-shrink-0 items-center justify-center rounded-[7px] mt-0.5 max-[600px]:size-6',
            'bg-gradient-to-br from-[var(--accent)] to-[var(--accent-dim)] text-[#001814]',
            'font-mono text-xs font-bold',
            'shadow-[0_0_14px_var(--accent-glow),inset_0_1px_0_rgba(255,255,255,0.3)]'
          )}
        >
          C
        </div>
      )}
      <div className={cn('flex-1 min-w-0', hideAvatar && 'ml-10')}>
        {/* 角色标签：连续消息或工具类消息时隐藏（M2: tool_call 等不显示角色标签） */}
        {!hideAvatar && (
          // M10: 角色标签字间距 0.08em（对齐原型 .msg-role { letter-spacing:0.08em }）
          <div className="mb-[5px] flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
            <span className="size-[3px] rounded-full bg-[var(--accent)]" />
            {ROLE_LABEL.assistant}
            {modelName && (
              <>
                <span className="text-[var(--text-faint)]">·</span>
                <span>{modelName}</span>
              </>
            )}
            {/* 时间戳 */}
            <span className="ml-auto text-[var(--text-faint)]">
              {formattedTime}
            </span>
          </div>
        )}
        {/* 消息内容 */}
        {renderContent()}
        {/* hover 时显示操作栏（仅对文本消息显示） */}
        {(message.content === 'text' || message.content === 'reasoning') && (
          <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100">
            {/* I-M-008: 传递 onRegenerate 回调给操作栏（重新生成按钮） */}
            {/* P2-8: 传递 feedback 和 onFeedback 给操作栏（点赞/踩按钮） */}
            <MessageActions
              text={message.text}
              messageId={message.id}
              {...(onRegenerate !== undefined ? { onRegenerate } : {})}
              {...(onFeedback !== undefined ? { onFeedback } : {})}
              {...(feedback !== undefined ? { feedback } : {})}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// 使用 memo 包裹，避免不必要的重渲染
export const MessageBubble = memo(MessageBubbleComponent)
