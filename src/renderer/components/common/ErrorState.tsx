// src/renderer/components/common/ErrorState.tsx
// 通用错误状态组件 · 极简文学风
// ──────────────────────────────────────────────────────────────
// 设计：
// - 图标用 size-12 圆形 + 朱砂红淡底 + strokeWidth=1.5
// - 标题用衬线字体
// - 错误消息用衬线字体 + 行高放宽
// ──────────────────────────────────────────────────────────────
//
// 职责：
// - 在 query/mutation 失败时展示错误图标 + 消息 + 可选重试按钮
// - 用于 query isError 状态下的占位
//
// 注意：传入的错误对象会被统一通过 handleIpcError 提取 IpcError 消息，
// 调用方无需预先解码错误。

import { AlertCircle, RefreshCw } from 'lucide-react';
import type { ReactElement } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface ErrorStateProps {
  /** 错误对象（unknown，会通过 String(err?.message ?? err) 提取消息） */
  error: unknown;
  /** 重试回调（不传则不显示重试按钮） */
  onRetry?: () => void;
  /** 重试按钮文字（默认"重试"） */
  retryLabel?: string;
  /** 容器样式（用于覆盖默认 py-16） */
  className?: string;
}

/**
 * 从 unknown 错误中提取可读消息
 *
 * 优先使用 Error.message，否则回退到 String(err)。
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * 通用错误状态
 *
 * @example
 * {isError && <ErrorState error={error} onRetry={() => refetch()} />}
 */
export function ErrorState({
  error,
  onRetry,
  retryLabel = '重试',
  className,
}: ErrorStateProps): ReactElement {
  const message = extractMessage(error);

  return (
    <div
      className={cn('text-error flex flex-col items-center justify-center gap-3 py-16', className)}
    >
      {/* 朱砂红淡底 + strokeWidth=1.5 */}
      <div className="bg-error/10 text-error flex size-12 items-center justify-center rounded-full">
        <AlertCircle className="size-6" strokeWidth={1.5} />
      </div>
      <div className="text-center">
        {/* 标题用衬线字体 */}
        <p className="text-foreground font-serif text-sm font-medium tracking-wide">加载失败</p>
        {/* 错误消息用衬线字体 + 行高放宽 */}
        <p className="text-muted-foreground mt-1 max-w-md font-serif text-xs leading-relaxed">
          {message}
        </p>
      </div>
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3" strokeWidth={1.5} />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
