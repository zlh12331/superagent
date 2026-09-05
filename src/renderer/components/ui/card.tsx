// src/renderer/components/ui/card.tsx
// 卡片容器（shadcn Card 的本项目适配：无框底色卡）
// ──────────────────────────────────────────────
// 形态收敛（2026-09 一致性审计）：此前 bg-card 容器在 11 个文件手写 12 种
// 组合。默认形态对齐最高频用法（bg-card rounded-lg px-3 py-2），padding /
// 布局由 className 覆盖（tailwind-merge 处理冲突）；带边框的行卡仍走
// settings-controls 的 SettingRow 体系。
//
// 用法：
//   <Card>…</Card>
//   <Card className="px-4 py-8">…</Card>          // 覆盖内边距
//   <Card interactive onClick={…}>…</Card>         // 可点击卡（hover 反馈）
// ──────────────────────────────────────────────

import type { ComponentPropsWithoutRef, ReactElement } from 'react';

import { cn } from '@/lib/utils';

export interface CardProps extends ComponentPropsWithoutRef<'div'> {
  /** 可点击卡：hover 底色反馈 + 手型光标（交互语义仍由调用方的 onClick 提供） */
  readonly interactive?: boolean;
}

export function Card({ className, interactive = false, ...props }: CardProps): ReactElement {
  return (
    <div
      data-slot="card"
      className={cn(
        'bg-card rounded-lg px-3 py-2',
        interactive && 'hover:bg-muted/60 cursor-pointer transition-colors',
        className,
      )}
      {...props}
    />
  );
}
