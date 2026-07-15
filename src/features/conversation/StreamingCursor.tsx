/**
 * StreamingCursor — 流式回复光标
 *
 * 对应 prototype.html 的 `.cursor` 元素。
 * 流式回复时，在文本末尾显示一个青绿色闪烁方块，提示"正在输入"。
 *
 * 动画使用 App.css 中定义的 `blink` 关键帧（1s infinite）。
 *
 * 参考样式：prototype.html 第 788-796 行
 */

import { cn } from '@/lib/utils'

export interface StreamingCursorProps {
  /** 额外的 className（用于调整位置等） */
  className?: string
}

/**
 * 流式光标组件。
 *
 * 视觉规格：8px × 14px 青绿色方块，带 accent-glow 发光阴影，
 * 使用 `blink` 动画实现 1s 周期闪烁。
 */
export function StreamingCursor({ className }: StreamingCursorProps) {
  return (
    <span
      className={cn(
        // inline-block 以便跟随文本流，垂直对齐到文本底部
        'inline-block align-text-bottom',
        // 尺寸：8px 宽 × 14px 高
        'w-2 h-3.5',
        // 背景色 + 发光阴影
        'bg-[var(--accent)]',
        'shadow-[0_0_8px_var(--accent-glow)]',
        // 闪烁动画（App.css 中定义的 @keyframes blink）
        'animate-[blink_1s_infinite]',
        // 左侧留 2px 间距，避免紧贴文字
        'ml-0.5',
        className
      )}
      // 对屏幕阅读器隐藏纯装饰性光标
      aria-hidden="true"
    />
  )
}
