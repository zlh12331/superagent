/**
 * TypingIndicator — AI 思考指示器
 *
 * 对应 prototype.html 的 `.typing-indicator` + `.ti-dot`。
 * AI 正在思考时，显示三个青绿色圆点波浪式跳动的加载动画。
 *
 * 动画使用 App.css 中定义的 `typing-bounce` 关键帧（1.4s infinite ease-in-out），
 * 三个点依次延迟 0s / 0.16s / 0.32s，形成波浪效果。
 *
 * 参考样式：prototype.html 第 800-818 行
 */

import { cn } from '@/lib/utils'

export interface TypingIndicatorProps {
  /** 额外的 className */
  className?: string
}

/** 三个圆点的动画延迟（秒），依次递增形成波浪效果 */
const DOT_DELAYS = [0, 0.16, 0.32] as const

/**
 * AI 思考指示器组件。
 *
 * 视觉规格：三个 7px 圆点，accent 色背景，使用 typing-bounce 动画
 * 实现波浪式上下跳动。整体水平排列，居中对齐。
 */
export function TypingIndicator({ className }: TypingIndicatorProps) {
  return (
    <div
      className={cn('flex items-center gap-1.5', className)}
      role="status"
      aria-label="AI 正在思考"
    >
      {DOT_DELAYS.map((delay, index) => (
        <span
          key={index}
          className={cn(
            // 圆点尺寸：7px × 7px 圆形
            'size-[7px] rounded-full',
            // 青绿色背景
            'bg-[var(--accent)]',
            // 波浪式跳动动画（App.css 中定义的 @keyframes typing-bounce）
            'animate-[typing-bounce_1.4s_infinite_ease-in-out]'
          )}
          // 每个点依次延迟，形成波浪效果
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </div>
  )
}
