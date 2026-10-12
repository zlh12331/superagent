import type { ComponentPropsWithoutRef, ReactElement } from 'react';

import { cn } from '@/lib/utils';

/** 卡片容器（bg-card 圆角底 + 内边距；交互形态见文件头注释的审计说明） */
export function Card({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactElement {
  return (
    <div data-slot="card" className={cn('bg-card rounded-lg px-3 py-2', className)} {...props} />
  );
}
