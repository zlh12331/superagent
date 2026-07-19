// src/renderer/components/common/ErrorState.tsx
// 通用错误状态组件
// 设计文档 §7.4 错误处理流程 / §7.10 用户友好提示
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
      className={cn(
        'text-destructive flex flex-col items-center justify-center gap-3 py-16',
        className,
      )}
    >
      <div className="bg-destructive/10 text-destructive flex size-12 items-center justify-center rounded-full">
        <AlertCircle className="size-6" />
      </div>
      <div className="text-center">
        <p className="text-foreground text-sm font-medium">加载失败</p>
        <p className="text-muted-foreground mt-1 max-w-md text-xs">{message}</p>
      </div>
      {onRetry !== undefined && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RefreshCw className="size-3" />
          {retryLabel}
        </Button>
      )}
    </div>
  );
}
