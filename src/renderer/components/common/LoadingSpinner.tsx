// src/renderer/components/common/LoadingSpinner.tsx
// 通用加载中组件
// 设计文档 §7.10 用户友好提示
//
// 职责：
// - 在数据加载中展示旋转图标 + 可选提示文字
// - 用于 query isLoading 状态下的占位

import { Loader2 } from 'lucide-react';
import type { ReactElement } from 'react';

import { cn } from '@/lib/utils';

interface LoadingSpinnerProps {
  /** 提示文字（默认"加载中..."） */
  label?: string;
  /** 图标尺寸（默认 size-6） */
  size?: 'sm' | 'md' | 'lg';
  /** 容器样式（用于覆盖默认 py-16） */
  className?: string;
}

const SIZE_MAP = {
  sm: 'size-4',
  md: 'size-6',
  lg: 'size-8',
} as const;

/**
 * 通用加载中组件
 *
 * @example
 * {isLoading && <LoadingSpinner />}
 * {isLoading && <LoadingSpinner label="正在加载章节..." size="lg" />}
 */
export function LoadingSpinner({
  label = '加载中...',
  size = 'md',
  className,
}: LoadingSpinnerProps): ReactElement {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-col items-center justify-center gap-2 py-16',
        className,
      )}
    >
      <Loader2 className={cn('animate-spin', SIZE_MAP[size])} />
      <span className="text-xs">{label}</span>
    </div>
  );
}
