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
//
// 可点击整卡请用 <button>（或 ui/button），不要把 onClick 挂在 Card 上：
// 此前有一个 interactive prop（hover 反馈 + 手型光标）且文档示例正是
// `<Card interactive onClick>`，但 div + onClick 无键盘可达性/无按钮语义
// （WCAG 2.1.1），该 prop 全仓零调用，已于 2026-09 审计移除。
// ──────────────────────────────────────────────

import type { ComponentPropsWithoutRef, ReactElement } from 'react';

import { cn } from '@/lib/utils';

export function Card({ className, ...props }: ComponentPropsWithoutRef<'div'>): ReactElement {
  return (
    <div data-slot="card" className={cn('bg-card rounded-lg px-3 py-2', className)} {...props} />
  );
}
