// src/renderer/components/common/EmptyState.tsx
// 通用空状态组件
// 设计文档 §7.10 用户友好提示
//
// 职责：
// - 展示空状态图标 + 标题 + 描述 + 可选操作按钮
// - 用于列表为空、无搜索结果等场景
//
// 注意：此组件为展示型组件，不包含业务逻辑，所有内容通过 props 传入。

import { Inbox } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  /** 图标（默认 Inbox 图标） */
  icon?: ReactNode;
  /** 标题 */
  title: string;
  /** 描述文字 */
  description?: string;
  /** 操作按钮文字（如"新建项目"），不传则不显示按钮 */
  actionLabel?: string;
  /** 操作按钮点击回调 */
  onAction?: () => void;
}

/**
 * 通用空状态
 *
 * @example
 * <EmptyState
 *   title="暂无项目"
 *   description="点击新建项目开始你的写作之旅"
 *   actionLabel="新建项目"
 *   onAction={() => setCreateOpen(true)}
 * />
 */
export function EmptyState({
  icon,
  title,
  description,
  actionLabel,
  onAction,
}: EmptyStateProps): ReactElement {
  return (
    <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16">
      <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        {icon ?? <Inbox className="size-6" />}
      </div>
      <div className="text-center">
        <p className="text-foreground text-sm font-medium">{title}</p>
        {description !== undefined && <p className="mt-1 text-xs">{description}</p>}
      </div>
      {actionLabel !== undefined && onAction !== undefined && (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
