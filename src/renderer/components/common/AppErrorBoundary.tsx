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

import { AlertTriangle, RefreshCw, Send } from 'lucide-react';
import type { ErrorInfo, ReactElement } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n';
import { reportError } from '@/lib/error-report';
import { unwrap } from '@/lib/ipc';

/** 项目 GitHub 新建 issue 入口（开源报障后端；本地优先路线的错误出口） */
const REPO_NEW_ISSUE_URL = 'https://github.com/zlh12331/superagent/issues/new';

/** issue 正文引用的堆栈行数上限（避免 URL 超长被 GitHub 截断） */
const MAX_STACK_LINES = 6;

/**
 * 组装预填 issue 深链：标题 = 错误消息首行，正文 = 堆栈摘要 + 版本环境 + 诊断包引导
 *
 * 正文文案同样走 i18n：此前是硬编码中文常量，英文界面下用户点开的是一个
 * 中文预填的 issue（本文件其余文案早已全部 i18n，此处是唯一漏网）。
 */
async function buildIssueUrl(message: string, error: unknown): Promise<string> {
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  let envLine = '';
  try {
    const info = unwrap(await window.api.app.getInfo());
    envLine = i18n.t('common.crashIssueVersion', {
      version: info.version,
      platform: info.platform,
      arch: info.arch,
      electron: info.electron,
    });
  } catch {
    // getInfo 失败不阻塞报障，仅缺版本行
  }
  const body = [
    i18n.t('common.crashIssueHeading'),
    '',
    '```',
    message,
    ...stack.split('\n').slice(0, MAX_STACK_LINES),
    '```',
    '',
    envLine,
    i18n.t('common.crashIssueSteps'),
    i18n.t('common.crashIssueAttach'),
  ].join('\n');
  const title = `[crash] ${message.slice(0, 80)}`;
  return `${REPO_NEW_ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

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
  // 文案经 i18next 全局单例 i18n.t() 取，**不用 useTranslation() hook**：
  // 与 SectionFallback 同一约束（fallback 零 hook/context 依赖）——
  // 错误边界 fallback 在 React 的错误恢复渲染路径中执行，此时 hooks 宿主不可靠
  // （实测 react-i18next 的 useTranslation 在此路径抛 Invalid hook call）；
  // i18n.t() 是纯数据访问，不依赖 hooks 宿主，且随当前语言切换。
  const message = error instanceof Error ? error.message : String(error);

  // 报障：深链 GitHub 新建 issue（预填崩溃信息与版本环境；诊断包由用户手动附上）
  const handleSendReport = (): void => {
    void buildIssueUrl(message, error)
      .then(async (url) => unwrap(await window.api.app.openExternal({ url })))
      .then(() => {
        toast.success(i18n.t('common.crashReportOpened'));
      })
      .catch(() => {
        toast.error(i18n.t('common.crashReportOpenFailed'));
      });
  };

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
        <h1 className="font-serif text-lg font-semibold tracking-wide">
          {i18n.t('common.appCrashed')}
        </h1>
        <p className="text-muted-foreground mt-2 max-w-md font-serif text-xs leading-relaxed">
          {message}
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={resetErrorBoundary}>
          <RefreshCw className="size-3" strokeWidth={1.5} />
          {i18n.t('common.reload')}
        </Button>
        <Button variant="outline" size="sm" onClick={handleSendReport}>
          <Send className="size-3" strokeWidth={1.5} />
          {i18n.t('common.sendCrashReport')}
        </Button>
      </div>
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
 * 在 App.tsx 中包裹 <AppErrorBoundary><AppProviders><RouterProvider /></AppProviders></AppErrorBoundary>。
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
        // 统一错误出口：electron-log renderer → 主进程落盘（随诊断包导出）
        // info.componentStack 帮助定位错误来源组件
        reportError(error, {
          tags: { boundary: 'AppErrorBoundary' },
          ...(info.componentStack !== null ? { componentStack: info.componentStack } : {}),
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
