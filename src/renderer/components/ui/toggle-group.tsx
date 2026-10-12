import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/** 切换组根容器（type 必填——Radix 不会从 value/onValueChange 推导；single 用受控 value） */
export function ToggleGroup({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root>): React.ReactElement {
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      className={cn('flex items-center gap-1', className)}
      {...props}
    />
  );
}

/** 切换组项（激活态由 Radix data-state=on 驱动） */
export function ToggleGroupItem({
  className,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>): React.ReactElement {
  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      className={cn(
        'text-muted-foreground hover:bg-accent/50 hover:text-foreground focus-visible:ring-ring flex-1 cursor-pointer rounded-md border border-transparent px-2.5 py-1 font-mono text-xs transition-colors focus-visible:ring-1 focus-visible:outline-none disabled:opacity-50 disabled:pointer-events-none',
        'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground',
        className,
      )}
      {...props}
    />
  );
}
