import { Inbox } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

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
  /** 附加类名（如 h-full 让空态在容器内垂直居中） */
  className?: string;
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
  className,
}: EmptyStateProps): ReactElement {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-col items-center justify-center gap-3 py-16',
        className,
      )}
    >
      <div className="bg-muted text-muted-foreground flex size-12 items-center justify-center rounded-full">
        {icon ?? <Inbox className="size-6" strokeWidth={1.5} data-testid="empty-default-icon" />}
      </div>
      <div className="text-center">
        <p className="text-foreground font-serif text-sm font-medium tracking-wide">{title}</p>
        {description !== undefined && (
          <p className="text-muted-foreground mt-1 font-serif text-xs leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {actionLabel !== undefined && onAction !== undefined && (
        <Button variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
