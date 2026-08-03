// src/renderer/components/common/AppErrorBoundary.tsx
// App 级错误边界（P1-4 分层错误边界第 1 层）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 包裹整个应用根（App.tsx 中包裹 AppProviders + RouterProvider）
// - 捕获 Provider 初始化异常 / RouterProvider 异常 / 任意子树未捕获错误
// - 提供"重新加载"按钮，触发整个应用根重新挂载
//
// 分层错误边界体系：
//   1. AppErrorBoundary（本组件）   → App 级：全屏兜底
//   2. RootErrorBoundary            → Route 级：捕获路由错误（react-router 已实现）
//   3. SectionErrorBoundary         → Component 级：局部错误隔离
//
// 设计：
// - 使用 react-error-boundary 6.x 的 ErrorBoundary 组件
// - fallbackRender 提供错误对象 + resetErrorBoundary 回调
// - onReset 调用 window.location.reload() 强制刷新页面
// - 不依赖任何 Provider（避免边界本身被错误 Provider 拖垮）
// ──────────────────────────────────────────────────────────────

import * as Sentry from '@sentry/electron/renderer';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { ErrorInfo, ReactElement } from 'react';
import { ErrorBoundary } from 'react-error-boundary';

import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';

/**
 * App 级错误边界的 fallback 渲染函数
 *
 * 全屏错误页面，仅依赖最基础的原生 DOM（无 Provider 依赖）。
 */
function AppFallback({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}): ReactElement {
  // 本地化文案（i18next 全局实例已 init，错误边界场景无需 Provider）
  const { t } = useTranslation();
  const message = error instanceof Error ? error.message : String(error);

  return (
    // data-testid 用于 E2E 测试与 CDP 动态分析检测 AppErrorBoundary 是否被触发
    <div
      data-testid="app-error-boundary"
      className="bg-background text-foreground flex h-screen w-screen flex-col items-center justify-center gap-4 p-8"
    >
      {/* 朱砂红淡底圆形 + 警告图标 */}
      <div className="bg-error/10 text-error flex size-16 items-center justify-center rounded-full">
        <AlertTriangle className="size-8" strokeWidth={1.5} />
      </div>

      <div className="text-center">
        <h1 className="font-serif text-lg font-semibold tracking-wide">{t('common.appCrashed')}</h1>
        <p className="text-muted-foreground mt-2 max-w-md font-serif text-xs leading-relaxed">
          {message}
        </p>
      </div>

      <Button variant="outline" size="sm" onClick={resetErrorBoundary}>
        <RefreshCw className="size-3" strokeWidth={1.5} />
        {t('common.reload')}
      </Button>
    </div>
  );
}

interface AppErrorBoundaryProps {
  /** 子组件树（通常是 AppProviders + RouterProvider） */
  children: React.ReactNode;
}

/**
 * App 级错误边界
 *
 * 在 App.tsx 中包裹 <AppProviders><RouterProvider /></AppProviders>。
 *
 * 错误恢复策略：
 * - onReset 调用 window.location.reload()，浏览器/Electron 重新加载页面
 * - 这会重新执行 main.tsx，重新初始化所有 Provider 与 Router
 *
 * @example
 * ```tsx
 * <AppErrorBoundary>
 *   <AppProviders>
 *     <RouterProvider router={router} />
 *   </AppProviders>
 * </AppErrorBoundary>
 * ```
 */
export function AppErrorBoundary({ children }: AppErrorBoundaryProps): ReactElement {
  return (
    <ErrorBoundary
      fallbackRender={AppFallback}
      onError={(error: unknown, info: ErrorInfo) => {
        // 上报到 Sentry（renderer → main → OTLP）
        // info.componentStack 帮助定位错误来源组件
        Sentry.captureException(error, {
          contexts: { react: { componentStack: info.componentStack } },
          tags: { boundary: 'AppErrorBoundary' },
        });
      }}
      onReset={() => {
        window.location.reload();
      }}
    >
      {children}
    </ErrorBoundary>
  );
}
