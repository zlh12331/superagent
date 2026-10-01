// src/renderer/components/common/BrandMark.tsx
// 品牌标识（顶栏 22px / 欢迎页大字区共用，单一真源）
// ──────────────────────────────────────────────────────────────
// 形态（TraeWork quiet · C3 实心）：accent 圆角实心方块 + 背景色切角括号。
// 用 SVG 而非 CSS 伪元素实现：任意尺寸下描边与圆角都清晰。
// 唯一填充：flat 实心 var(--accent)——禁止双 accent 渐变（design-identity 1.2=A）。
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';

interface BrandMarkProps {
  /** 边长（px）：顶栏 22 / 欢迎页品牌区 40 */
  readonly size?: number;
  readonly className?: string;
}

/** 品牌标记 SVG：实心 accent + 切角括号，尺寸可调（默认 22px） */
export function BrandMark({ size = 22, className }: BrandMarkProps): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 22 22"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect width="22" height="22" rx="6" fill="var(--accent)" />
      {/* 切角括号：inset 5px + 1.5px 描边 + 左上 2px 圆角（路径取边框中心线 5.75） */}
      <path
        d="M5.75 17 V7.75 Q5.75 5.75 7.75 5.75 H17"
        fill="none"
        stroke="var(--background)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
