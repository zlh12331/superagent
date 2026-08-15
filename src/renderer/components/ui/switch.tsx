// src/renderer/components/ui/switch.tsx
// 开关组件（shadcn/ui new-york 风格，基于 @radix-ui/react-switch）
// 设计文档 §2.3 shadcn/ui 组件库

import * as SwitchPrimitive from '@radix-ui/react-switch';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * 开关组件
 *
 * 包装 Radix Switch Primitive，受控组件（checked + onCheckedChange）。
 * ──────────────────────────────
 * 变体：无（尺寸由 className 控制）
 * 状态：受控（checked + onCheckedChange）| 非受控（defaultChecked）
 * 依赖：@radix-ui/react-switch
 * 可访问性：Radix 内置 role=switch + aria-checked + Space/Enter 键盘切换
 * ──────────────────────────────
 */
export function Switch({
  className,
  ...props
}: React.ComponentProps<typeof SwitchPrimitive.Root>): React.ReactElement {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        'peer data-[state=checked]:bg-primary data-[state=unchecked]:bg-input focus-visible:border-ring focus-visible:ring-ring/50 inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent shadow-xs transition-all outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          'bg-background pointer-events-none block size-4 rounded-full ring-0 shadow-lg transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0',
        )}
      />
    </SwitchPrimitive.Root>
  );
}
