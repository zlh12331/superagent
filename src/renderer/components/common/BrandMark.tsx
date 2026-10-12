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
      <path
        d="M5.75 17 V7.75 Q5.75 5.75 7.75 5.75 H17"
        fill="none"
        stroke="var(--background)"
        strokeWidth="1.5"
      />
    </svg>
  );
}
