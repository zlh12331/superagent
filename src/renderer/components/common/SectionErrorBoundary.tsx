// src/renderer/components/common/SectionErrorBoundary.tsx
// Component 级错误边界（P1-4 分层错误边界第 3 层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 包裹业务局部组件（如 ChatPanel / TerminalPanel / ApprovalList）
// - 捕获子组件抛出的错误，仅本区域显示错误回退，不影响其他区域
// - 支持 resetKeys 触发自动重置（外部依赖变化时重新挂载）
//
// 分层错误边界体系：
//   1. AppErrorBoundary               → App 级：全屏兜底
//   2. RootErrorBoundary              → Route 级：捕获路由错误
//   3. SectionErrorBoundary（本组件）  → Component 级：局部错误隔离
//
// 设计：
// - 使用 react-error-boundary 6.x 的 ErrorBoundary 组件
// - fallback 复用 ErrorState（保持视觉一致性）
// - 复用 ErrorState 的 onRetry 调用 resetErrorBoundary，重新挂载子组件
// - 默认不传 resetKeys，仅手动重试；调用方可传入 resetKeys 自动重置
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { ErrorState } from '@/components/common/ErrorState';

interface SectionErrorBoundaryProps {
  /** 子组件树（业务局部组件） */
  children: ReactNode;
  /**
   * 重置键数组
   *
   * 当数组中任意值变化时，自动重置错误边界（重新挂载子组件）。
   * 常用于：sessionId 变化时重置 ChatPanel、终端 id 变化时重置 TerminalPanel。
   *
   * 注意：react-error-boundary 6.x 的 resetKeys 类型为 `unknown[]`（非只读），
   * 这里接受 ReadonlyArray 后内部拷贝为可变数组传递。
   */
  resetKeys?: ReadonlyArray<unknown>;
  /**
   * 重试按钮文字（默认"重试"，透传给 ErrorState）
   */
  retryLabel?: string;
  /** 容器样式（透传给 ErrorState） */
  className?: string;
}

/**
 * Component 级错误边界
 *
 * 局部错误隔离：单个业务面板崩溃不影响其他面板。
 *
 * @example
 * ```tsx
 * <SectionErrorBoundary resetKeys={[sessionId]}>
 *   <ChatPanel sessionId={sessionId} />
 * </SectionErrorBoundary>
 * ```
 */
export function SectionErrorBoundary({
  children,
  resetKeys,
  retryLabel,
  className,
}: SectionErrorBoundaryProps): ReactElement {
  // exactOptionalPropertyTypes: 可选属性仅在非 undefined 时传递
  // react-error-boundary 6.x resetKeys 期望 unknown[]，这里拷贝为可变数组
  return (
    <ErrorBoundary
      fallbackRender={({ error, resetErrorBoundary }) => (
        <ErrorState
          error={error}
          onRetry={resetErrorBoundary}
          {...(retryLabel !== undefined ? { retryLabel } : {})}
          {...(className !== undefined ? { className } : {})}
        />
      )}
      {...(resetKeys !== undefined ? { resetKeys: [...resetKeys] } : {})}
    >
      {children}
    </ErrorBoundary>
  );
}
