/**
 * CodeBlock — 代码块（带语法高亮和复制按钮）
 *
 * 对应 prototype.html 的 `.code-block-wrapper` + `.cb-head` + `.cb-body`。
 * 独立可用的代码块组件，接受 code 字符串 + language，渲染带语法高亮的代码。
 *
 * 语法高亮：依赖 rehype-highlight 的 CSS 类（hljs 系列），本组件不自实现高亮。
 * 当 code 内容已被 hljs 标记包裹时，直接展示；否则以纯文本等宽字体显示。
 *
 * 复制功能：顶部栏右侧复制按钮，hover 时显示，点击后复制代码到剪贴板。
 *
 * 参考样式：prototype.html 第 870-891 行
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'
import { logger } from '@/lib/logger'
import { cn } from '@/lib/utils'

export interface CodeBlockProps {
  /** 代码内容 */
  code: string
  /** 语言标识（如 ts、rust、json），用于显示语言标签 */
  language?: string | undefined
  /** 额外的 className */
  className?: string
}

/**
 * 代码块组件。
 *
 * 结构：
 * - 顶部栏（cb-head）：语言标签 + 复制按钮（hover 显示）
 * - 代码体（cb-body）：等宽字体显示代码内容，支持横向滚动
 *
 * 复制按钮点击后切换为"已复制"状态（绿色对勾），2 秒后恢复。
 */
export function CodeBlock({ code, language, className }: CodeBlockProps) {
  // 是否已复制（用于切换按钮图标和样式）
  const [copied, setCopied] = useState(false)
  // 复制状态恢复 timer 的句柄 —— 组件卸载时清理，避免对已卸载组件调用 setState
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 组件卸载时清理 timer
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
        copiedTimerRef.current = null
      }
    }
  }, [])

  // 复制代码到剪贴板
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      // 清理上一次未完成的 timer，避免重复触发 setState
      if (copiedTimerRef.current !== null) {
        clearTimeout(copiedTimerRef.current)
      }
      // 2 秒后恢复为未复制状态 —— 保存到 ref 以便卸载时清理
      copiedTimerRef.current = setTimeout(() => {
        setCopied(false)
        copiedTimerRef.current = null
      }, 2000)
    } catch (error) {
      // 剪贴板 API 不可用时提示用户手动复制（如非 HTTPS 环境或权限被拒）
      logger.warn('Clipboard write failed', { error })
      toast.error('复制失败，请手动选择文本复制')
    }
  }, [code])

  return (
    <div
      className={cn(
        // 外层容器：相对定位，圆角 + 边框 + 溢出隐藏
        // E1: 移除 overflow-hidden，允许浮动复制按钮溢出顶部栏（按钮绝对定位在右上角）
        'group relative rounded-lg border border-[var(--border)] bg-[var(--bg-elev)]',
        className
      )}
    >
      {/* 顶部栏：仅保留语言标签（复制按钮已移至浮动位置） */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-elev-2)] px-3 py-1.5">
        {/* 语言标签（mono 字体，小号） */}
        <span className="font-mono text-[10px] uppercase tracking-wider text-[var(--text-faint)]">
          {language ?? 'text'}
        </span>
      </div>

      {/* 代码体：等宽字体，横向滚动，保留空白字符 */}
      <pre className="overflow-x-auto p-3">
        {/* 使用 hljs CSS 类，配合 rehype-highlight 的样式表实现语法高亮 */}
        <code
          className={cn(
            'hljs font-mono text-[12.5px] leading-relaxed text-[var(--text)]',
            language ? `language-${language}` : ''
          )}
        >
          {code}
        </code>
      </pre>

      {/* E1: 复制按钮浮动在代码块右上角，默认隐藏，hover 时显示 */}
      <button
        type="button"
        onClick={handleCopy}
        className={cn(
          'absolute top-2 right-2 flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] transition-all',
          'border-[var(--border)] bg-[var(--bg-elev-2)] text-[var(--text-faint)]',
          // 默认隐藏，hover 代码块时显示
          'opacity-0 group-hover:opacity-100',
          'hover:border-[var(--accent-dim)] hover:text-[var(--accent)]',
          // 已复制状态始终显示
          copied && 'border-[var(--accent)] text-[var(--accent)] opacity-100'
        )}
        aria-label={copied ? '已复制' : '复制代码'}
      >
        {copied ? (
          <>
            <Check className="size-3" />
            <span>已复制</span>
          </>
        ) : (
          <>
            <Copy className="size-3" />
            <span>复制</span>
          </>
        )}
      </button>
    </div>
  )
}
