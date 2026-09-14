// src/renderer/components/common/SectionErrorBoundary.tsx
// 组件级错误边界（分层错误边界体系第 3 层）
// ──────────────────────────────────────────────────────────────
// 分层错误边界体系：
//   1. AppErrorBoundary（本体系第 1 层）   → App 级：全屏兜底
//   2. RootErrorBoundary（react-router）   → Route 级：捕获路由错误
//   3. SectionErrorBoundary（本组件）      → Component 级：局部错误隔离
//
// 职责：
// - 包裹独立业务区块（设置 pane / 右面板 tab / 侧栏分区等）
// - 区块内组件抛错时局部降级（内联错误提示 + 重试），不拖垮整个 App
// - 错误上报统一出口（与 AppErrorBoundary 同机制，tag 区分层级）
//
// 使用方式：
//   <SectionErrorBoundary>
//     <SettingsPaneContent />
//   </SectionErrorBoundary>
// ──────────────────────────────────────────────────────────────

import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n';
import { reportError } from '@/lib/error-report';

/**
 * 区块级 fallback：内联小卡片（不占全屏），保留重试入口
 *
 * 设计约束：fallback 不依赖任何 hook/context（错误边界 fallback 必须零依赖——
 * 若错误源恰是 Provider/context，fallback 复用它会二次失败；
 * 且 React 19 的 render 阶段错误恢复对 fallback 内 hook 调用有限制）。
 * 文案经 i18next 全局单例 i18n.t() 取（纯数据访问，非 React hook/context，
 * 不破坏 fallback 零依赖约束），并随当前语言自动切换、无需双份硬编码。
 */
function SectionFallback({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}): ReactElement {
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div
      role="alert"
      data-testid="section-error-boundary"
      className="bg-error/5 border-error/20 text-error flex flex-col items-center gap-2 rounded-md border px-4 py-6"
    >
      <AlertTriangle className="size-5" strokeWidth={1.5} />
      <p className="text-xs leading-relaxed">
        {i18n.t('common.sectionLoadFailed', { defaultValue: '区块加载失败，请重试' })}
      </p>
      <p className="text-muted-foreground max-w-full truncate font-mono text-2xs" title={message}>
        {message}
      </p>
      <Button variant="outline" size="sm" onClick={resetErrorBoundary}>
        <RefreshCw className="size-3" strokeWidth={1.5} />
        {i18n.t('common.retry', { defaultValue: '重试' })}
      </Button>
    </div>
  );
}

/** SectionErrorBoundary props */
export interface SectionErrorBoundaryProps {
  /** 需要隔离的区块内容 */
  readonly children: ReactNode;
  /** 错误标识前缀（上报 tag 区分区块） */
  readonly name?: string;
  /**
   * 重置键：任一元素变化时自动清除错误状态并重渲染 children
   * （对齐参考项目 ErrorBoundary 的 resetKey 语义——切换 tab/会话后不残留上个区块的错误）
   */
  readonly resetKeys?: readonly unknown[];
}

/**
 * 组件级错误边界：区块内错误局部降级，不拖垮整个 App
 */
export function SectionErrorBoundary({
  children,
  name,
  resetKeys,
}: SectionErrorBoundaryProps): ReactElement {
  return (
    <ErrorBoundary
      fallbackRender={SectionFallback}
      // 条件展开 + 断言：resetKeys 未传时不携带字段；readonly 数组转 unknown[]
      // （react-error-boundary 的 resetKeys 类型为非 readonly unknown[]）
      {...(resetKeys !== undefined ? { resetKeys: resetKeys as unknown[] } : {})}
      onError={(error: unknown, info: { componentStack?: string | null }) => {
        reportError(error, {
          tags: { boundary: 'SectionErrorBoundary', section: name ?? 'unknown' },
          ...(info.componentStack != null ? { componentStack: info.componentStack } : {}),
        });
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
