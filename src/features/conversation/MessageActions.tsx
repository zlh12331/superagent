/**
 * MessageActions — 消息 hover 操作栏
 *
 * 对应 prototype.html 的 `.msg-actions`。
 * 消息被 hover 时显示的操作按钮栏，提供复制、重试、编辑快捷操作。
 *
 * 交互：默认隐藏（opacity-0），父级消息 hover 时显示（opacity-1）。
 * 本组件通过 CSS group-hover 实现显隐，父级消息需添加 `group` 类。
 *
 * 参考样式：prototype.html 第 839-867 行
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy, RotateCcw, ThumbsDown, ThumbsUp } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

export interface MessageActionsProps {
  /** 消息文本内容（用于复制） */
  text: string
  /** I-M-008: 重新生成回调（点击重试按钮时触发）。
   *  接收 messageId 参数，由调用方绑定具体消息，
   *  避免父组件为每条消息内联箭头函数破坏子组件 memo。 */
  onRegenerate?: (messageId: string) => void
  /** 当前消息 ID（传递给 onRegenerate 回调） */
  messageId?: string
  /** P2-8: 当前反馈状态（'up' 点赞 / 'down' 踩 / null 无反馈） */
  feedback?: 'up' | 'down' | null
  /** P2-8: 反馈回调（点击点赞/踩按钮时触发） */
  onFeedback?: (type: 'up' | 'down') => void
  /** 额外的 className */
  className?: string
}

/** 操作按钮配置（图标 + 标签 + 点击行为标识）
 *
 * 对齐原型 addMsgActions：仅保留 copy + regenerate 两个按钮（无 edit/like/dislike）。
 */
interface ActionButtonConfig {
  /** 按钮标识 */
  id: 'copy' | 'retry'
  /** 图标组件 */
  icon: typeof Copy
  /** 按钮标签文本 */
  label: string
}

const ACTION_BUTTONS: ActionButtonConfig[] = [
  { id: 'copy', icon: Copy, label: '复制' },
  { id: 'retry', icon: RotateCcw, label: '重新生成' },
]

/**
 * 消息 hover 操作栏组件。
 *
 * 当前按钮（对齐原型 addMsgActions）：
 * - 复制：使用 navigator.clipboard.writeText 复制消息文本，点击后切换为"已复制"状态
 * - 重新生成：预留入口（后续接入重试逻辑）
 *
 * 显隐控制：依赖父级 `group` 类，通过 `opacity-0 group-hover:opacity-100` 实现。
 */
export function MessageActions({ text, onRegenerate, messageId, feedback, onFeedback, className }: MessageActionsProps) {
  // 复制是否成功（用于切换按钮为"已复制"状态）
  const [copied, setCopied] = useState(false)
  // P2-8: setTimeout 计时器引用，组件卸载时清理避免在已卸载组件上 setState
  const copyResetTimerRef = useRef<number | null>(null)

  // 组件卸载时清理复制状态重置定时器，避免 "setState on unmounted component" 警告
  useEffect(() => {
    return () => {
      if (copyResetTimerRef.current !== null) {
        clearTimeout(copyResetTimerRef.current)
      }
    }
  }, [])

  // 处理按钮点击
  const handleClick = useCallback(
    async (actionId: ActionButtonConfig['id']) => {
      if (actionId === 'copy') {
        try {
          await navigator.clipboard.writeText(text)
          setCopied(true)
          // 2 秒后恢复（清理上一次的定时器，避免定时器叠加）
          if (copyResetTimerRef.current !== null) {
            clearTimeout(copyResetTimerRef.current)
          }
          copyResetTimerRef.current = window.setTimeout(() => setCopied(false), 2000)
        } catch {
          // 剪贴板 API 不可用时静默失败
        }
      }
      // I-M-008: 重新生成 — 触发回调（携带 messageId）并给出 toast 反馈
      if (actionId === 'retry') {
        if (onRegenerate && messageId !== undefined) {
          onRegenerate(messageId)
        }
        toast.info('正在重新生成…')
      }
    },
    [text, onRegenerate, messageId]
  )

  // P2-8: 处理反馈按钮点击（点赞/踩）
  const handleFeedback = useCallback(
    (type: 'up' | 'down') => {
      onFeedback?.(type)
      toast.info(type === 'up' ? '已点赞' : '已点踩')
    },
    [onFeedback]
  )

  return (
    <div
      className={cn(
        'flex items-center gap-0.5',
        // 默认隐藏，父级 group hover 时显示
        'opacity-0 transition-opacity duration-150 group-hover:opacity-100',
        className
      )}
    >
      {ACTION_BUTTONS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          onClick={() => handleClick(id)}
          // I-M-008: 重新生成按钮添加 title 提示
          title={id === 'retry' ? '重新生成' : label}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-0.5',
            'text-[11px] text-[var(--text-faint)] transition-colors',
            'hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
            // 复制成功时按钮高亮为 accent 色
            id === 'copy' && copied && 'text-[var(--accent)]'
          )}
          aria-label={label}
        >
          {/* 复制按钮在已复制状态时切换为对勾图标 */}
          {id === 'copy' && copied ? (
            <Check className="size-3" />
          ) : (
            <Icon className="size-3" />
          )}
          {label}
        </button>
      ))}
      {/* P2-8: AI 反馈按钮（点赞/踩）— 仅当 onFeedback 存在时渲染 */}
      {onFeedback && (
        <>
          {/* 点赞按钮：feedback === 'up' 时高亮为 accent 色 */}
          <button
            type="button"
            onClick={() => handleFeedback('up')}
            title="赞"
            className={cn(
              'flex items-center gap-1 rounded px-2 py-0.5',
              'text-[11px] text-[var(--text-faint)] transition-colors',
              'hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
              feedback === 'up' && 'text-[var(--accent)]'
            )}
            aria-label="赞"
          >
            <ThumbsUp className="size-3" />
          </button>
          {/* 踩按钮：feedback === 'down' 时高亮为 error 色 */}
          <button
            type="button"
            onClick={() => handleFeedback('down')}
            title="踩"
            className={cn(
              'flex items-center gap-1 rounded px-2 py-0.5',
              'text-[11px] text-[var(--text-faint)] transition-colors',
              'hover:bg-[var(--bg-elev-2)] hover:text-[var(--text)]',
              feedback === 'down' && 'text-[var(--error)]'
            )}
            aria-label="踩"
          >
            <ThumbsDown className="size-3" />
          </button>
        </>
      )}
    </div>
  )
}
