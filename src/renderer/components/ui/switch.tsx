// src/renderer/components/ui/switch.tsx
// 开关组件（零依赖 button + role="switch"，对齐原型 .toggle-switch）
// ──────────────────────────────────────────────────────────────
// 设计：
// - button 元素 + role="switch" + aria-checked（键盘原生支持 Space/Enter）
// - 视觉：轨道 + 滑动圆点（checked 时 accent 色）
// - 受控组件：checked + onCheckedChange
// ──────────────────────────────────────────────────────────────

import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

/** Switch props */
export interface SwitchProps {
  /** 是否选中（受控） */
  readonly checked: boolean;
  /** 切换回调 */
  readonly onCheckedChange: (checked: boolean) => void;
  /** 无障碍标签（无可见文字时必填） */
  readonly 'aria-label'?: string;
  /** 额外 className */
  readonly className?: string;
  /** 禁用态 */
  readonly disabled?: boolean;
}

/**
 * 开关组件
 *
 * @example
 * ```tsx
 * <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="自动滚动" />
 * ```
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...rest
}: SwitchProps): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'focus-visible:ring-ring relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-input',
        className,
      )}
      {...rest}
    >
      <span
        className={cn(
          'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}
