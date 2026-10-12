import { AlertTriangle, RefreshCw, Send } from 'lucide-react';
import type { ErrorInfo, ReactElement } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { i18n } from '@/i18n';
import { fetchAppInfo, openExternal } from '@/lib/app-actions';
import { reportError } from '@/lib/error-report';

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
    const info = await fetchAppInfo();
    envLine = i18n.t('common.crashIssueVersion', {
      version: info.version,
      platform: info.platform,
      arch: info.arch,
      electron: info.electron,
    });
  } catch {}
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
 *
 * ⚠️ 必须以 `FallbackComponent`（而非 `fallbackRender`）挂载（2026-09-28）：
 * react-error-boundary 的 fallbackRender 是直接函数调用，而 React Compiler 会
 * 为本函数注入 memo 缓存 hook（`_c()` = useMemoCache）；类组件 render 路径没有
 * hooks dispatcher，直接调用即抛「Invalid hook call」——最后一道兜底自身崩溃，
 * 用户看到的是白屏而非本页。详见 SectionErrorBoundary 的同类注释。
 */
function AppFallback({
  error,
  resetErrorBoundary,
}: {
  error: unknown;
  resetErrorBoundary: () => void;
}): ReactElement {
  const message = error instanceof Error ? error.message : String(error);

  const handleSendReport = (): void => {
    void buildIssueUrl(message, error)
      .then(async (url) => {
        const started = await openExternal(url);
        if (!started) {
          throw new Error('openExternal unavailable');
        }
      })
      .then(() => {
        toast.success(i18n.t('common.crashReportOpened'));
      })
      .catch(() => {
        toast.error(i18n.t('common.crashReportOpenFailed'));
      });
  };

  return (
    <div
      data-testid="app-error-boundary"
      className="bg-background text-foreground flex h-screen w-screen flex-col items-center justify-center gap-4 p-8"
    >
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
      FallbackComponent={AppFallback}
      onError={(error: unknown, info: ErrorInfo) => {
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
