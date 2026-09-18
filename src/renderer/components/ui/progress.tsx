// src/renderer/components/ui/progress.tsx
// 进度条基元（确定性线性进度；自动更新下载进度引入，docs/design/27-auto-update-spec.md）
// ──────────────────────────────
// 变体：无（高度/圆角由 className 决定）
// 状态：无状态（受控 value；越界自动收敛到 0-100）
// 依赖：motion（宽度过渡，走 MotionVault 预设，避免每秒进度推送造成视觉抖动）
// 可访问性：role="progressbar" + aria-valuenow/min/max + aria-label（本地化文案必填）
// ──────────────────────────────

import { motion } from 'motion/react';
import type { ReactElement } from 'react';

import { microTransition } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 线性进度条 props */
export interface ProgressProps {
  /** 进度 0-100（越界自动收敛） */
  readonly value: number;
  /** 无障碍标签（读屏播报用；文案需本地化，说明当前进度语义） */
  readonly label: string;
  /** 附加样式（轨道高度等；外层宽度默认铺满） */
  readonly className?: string;
}

/**
 * 线性进度条
 *
 * @example
 * ```tsx
 * <Progress value={42} label={t('update.downloadingTitle', { version })} />
 * ```
 */
export function Progress({ value, label, className }: ProgressProps): ReactElement {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped)}
      aria-label={label}
      className={cn('bg-muted h-1.5 w-full overflow-hidden rounded-full', className)}
    >
      <motion.div
        className="bg-primary h-full rounded-full"
        initial={false}
        animate={{ width: `${clamped}%` }}
        transition={microTransition}
      />
    </div>
  );
}
