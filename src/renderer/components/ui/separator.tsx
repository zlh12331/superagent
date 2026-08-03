// src/renderer/components/ui/separator.tsx
// 分隔线组件（Radix UI Separator 封装）
// ──────────────────────────────────────────────────────────────
// 用于设置对话框分区、面板分隔等视觉分组。
// decorative 默认 true：纯装饰性分隔，屏幕阅读器跳过。
// ──────────────────────────────────────────────────────────────

import * as SeparatorPrimitive from '@radix-ui/react-separator';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/utils';

type SeparatorProps = ComponentProps<typeof SeparatorPrimitive.Root>;

/** 分隔线组件 */
export function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: SeparatorProps): React.ReactElement {
  return (
    <SeparatorPrimitive.Root
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'bg-border shrink-0',
        orientation === 'horizontal' ? 'h-px w-full' : 'h-full w-px',
        className,
      )}
      {...props}
    />
  );
}
