/**
 * ReasoningBlock — 可折叠推理摘要
 *
 * 对应 prototype.html 的 `.reasoning-block` + `.reasoning-head` + `.reasoning-body`。
 * 展示 AI 的推理过程摘要，包含耗时和 token 计数。
 *
 * 交互：默认展开，点击 head 切换展开/折叠。
 * 流式输出时（isStreaming=true），head 显示 spinner 表示正在思考。
 *
 * 参考样式：prototype.html 第 3480-3524 行
 */

import { useState } from 'react'
import { ChevronRight, Loader2 } from 'lucide-react'
import type { ReasoningBlock as ReasoningBlockData } from '@/lib/codex/types'
import { cn } from '@/lib/utils'

// 注意：类型名 ReasoningBlock 与本组件名冲突，故导入时别名为 ReasoningBlockData
export interface ReasoningBlockProps {
  /** 推理块数据 */
  reasoning: ReasoningBlockData
  /** 额外的 className */
  className?: string
}

/**
 * 将毫秒时长格式化为可读字符串。
 *
 * - < 1000ms：显示 "XXXms"
 * - >= 1000ms：显示 "X.Xs"
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

/**
 * 可折叠推理摘要组件。
 *
 * 结构：
 * - reasoning-head：
 *   - chevron 箭头（展开时旋转 90deg）
 *   - spinner（流式输出时显示，替代 chevron）
 *   - "推理摘要" 标题（mono 字体）
 *   - 时长 · token 计数（右侧，text-faint）
 * - reasoning-body（展开时）：推理文本，white-space: pre-wrap
 */
export function ReasoningBlock({ reasoning, className }: ReasoningBlockProps) {
  // 折叠状态：默认展开（对齐原型 .reasoning-block 带 open class，L13536）
  const [isOpen, setIsOpen] = useState(true)

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg-elev-2)]',
        className
      )}
    >
      {/* head：点击切换折叠 */}
      <button
        type="button"
        onClick={() => setIsOpen(prev => !prev)}
        className={cn(
          // P0 修复：
          //   - 加 cursor-pointer
          //   - transition 时长默认 150ms → duration-[120ms]（对齐原型 0.12s）
          'flex w-full cursor-pointer items-center gap-1.75 px-2.75 py-1.75 text-left',
          'bg-[var(--bg-elev-2)] transition-colors duration-[120ms] hover:bg-[var(--bg-elev)]',
          'select-none'
        )}
        aria-expanded={isOpen}
        aria-label="折叠/展开推理摘要"
      >
        {/* chevron 箭头或 spinner（流式时） */}
        {reasoning.isStreaming ? (
          <Loader2 className="size-2.75 animate-spin text-[var(--accent)]" />
        ) : (
          <ChevronRight
            className={cn(
              'size-2.75 text-[var(--text-faint)] transition-transform duration-200',
              isOpen && 'rotate-90'
            )}
          />
        )}

        {/* 标题 */}
        {/* P0 修复：tracking-wide(0.025em) → tracking-[0.04em]（对齐原型 .reasoning-title { letter-spacing:0.04em }） */}
        <span className="font-mono text-[11px] tracking-[0.04em] text-[var(--text-dim)]">
          推理摘要
        </span>

        {/* 时长 · token 计数（右侧自适应） */}
        <span className="ml-auto font-mono text-[10px] text-[var(--text-faint)]">
          {formatDuration(reasoning.durationMs)} · {reasoning.tokenCount} tokens
        </span>
      </button>

      {/* body：展开时显示推理文本 */}
      {isOpen && (
        <div
          className={cn(
            'border-t border-[var(--border)] px-3 py-2.5',
            // P0 修复：leading-relaxed(1.625) → leading-[1.6]（对齐原型 .reasoning-body { line-height:1.6 }）
            'font-mono text-[12.5px] leading-[1.6] text-[var(--text-dim)]',
            // pre-wrap 保留换行和连续空格
            'whitespace-pre-wrap'
          )}
        >
          {reasoning.content}
        </div>
      )}
    </div>
  )
}
