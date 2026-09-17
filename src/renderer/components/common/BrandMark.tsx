// src/renderer/components/common/BrandMark.tsx
// 品牌标识（顶栏 22px / 欢迎页大字区共用，单一真源）
// ──────────────────────────────────────────────────────────────
// 形态：accent 圆角实心方块 + 背景色切角括号（对齐原顶栏 .brand-mark 的
// `inset:5px` 左上圆角括号）。用 SVG 而非 CSS 伪元素实现：
// - 任意尺寸下描边与圆角都清晰（CSS 版本只在 22px 下调校过）
// - 顶栏与欢迎页共用同一实现，品牌语言一致
//
// variant：
// - flat（默认）顶栏用，实心 accent，保持既有观感不变
// - gradient 欢迎页大字区用，accent→accent-2 渐变，大尺寸下更有层次
// ──────────────────────────────────────────────────────────────

import { type ReactElement, useId } from 'react';

interface BrandMarkProps {
  /** 边长（px）：顶栏 22 / 欢迎页品牌区 40 */
  readonly size?: number;
  /** 填充处理：flat 实心强调色 / gradient 品牌渐变 */
  readonly variant?: 'flat' | 'gradient';
  readonly className?: string;
}

export function BrandMark({
  size = 22,
  variant = 'flat',
  className,
}: BrandMarkProps): ReactElement {
  // useId 产出形如 `:r0:`，冒号在 url(#…) 片段标识里不安全，故剥离
  const gradientId = `brand-mark-${useId().replaceAll(':', '')}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {variant === 'gradient' && (
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--accent-2)" />
          </linearGradient>
        </defs>
      )}
      <rect
        width="22"
        height="22"
        rx="6"
        fill={variant === 'gradient' ? `url(#${gradientId})` : 'var(--accent)'}
      />
      {/* 切角括号：对齐原 ::after 的 inset 5px + 1.5px 描边 + 左上 2px 圆角
          （描边居中于路径，故路径取边框中心线 5.75） */}
      <path
        d="M5.75 17 V7.75 Q5.75 5.75 7.75 5.75 H17"
        fill="none"
        stroke="var(--background)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
