/**
 * @file 主窗口入口文件。
 *
 * 职责：将 React 应用挂载到 #root，并装配全局 Provider（QueryClientProvider、StrictMode）。
 * 架构位置：Vite 构建主入口（对应 index.html），由 Tauri 主窗口加载。
 *
 * 关键点：
 *  - 在任何 React 代码执行前调用 initSentry()，确保启动期错误也能被捕获；
 *  - TanStack Query devtools 仅在开发环境懒加载，避免污染生产构建；
 *  - 通过 createRoot 的 onUncaughtError/onCaughtError + window error/unhandledrejection
 *    监听建立「全局错误兜底网」，确保未被 ErrorBoundary 捕获的错误也能上报到 Sentry。
 */

import ReactDOM from 'react-dom/client'
import { StrictMode, lazy, Suspense } from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import * as Sentry from '@sentry/react'
import { initSentry } from './lib/sentry'
import { logger } from './lib/logger'
import './i18n'
import App from './App'
import { queryClient } from './lib/query-client'

// 在任何 React 代码执行前初始化 Sentry。
// 事件会被捕获但在用户授予同意前不会发送
// （参见 use-crash-reporting.ts → setSentryConsent(true)）。
// 这样可确保即便在用户授予同意之前，启动期间的错误也能被捕获。
initSentry()

// 仅在开发模式懒加载 ReactQueryDevtools，保证生产环境
// 构建产物不含 devtools 代码（gzip 后约 30-50 KB）。
const ReactQueryDevtools = import.meta.env.DEV
  ? lazy(() =>
      import('@tanstack/react-query-devtools').then(m => ({
        default: m.ReactQueryDevtools,
      }))
    )
  : () => null

// ─── 全局错误兜底网 ─────────────────────────────────────────────────────────
// React 19 createRoot 的 onUncaughtError / onCaughtError 分别处理
// 未被 ErrorBoundary 捕获的错误与被 ErrorBoundary 捕获的错误。
// 配合 window 'error' 与 'unhandledrejection' 监听，覆盖以下场景：
//   1. 事件处理器中的同步异常（window error）
//   2. Promise 链中未被 catch 的 rejection（unhandledrejection）
//   3. React 渲染期间抛出但未被任何 ErrorBoundary 捕获的错误（onUncaughtError）
//   4. 被 ErrorBoundary 捕获的错误（onCaughtError，仅记录，ErrorBoundary 已渲染降级 UI）
//
// 所有错误统一通过 Sentry.captureException 上报，并使用 logger 本地记录，
// 便于线上问题追溯与本地开发调试。
// React 19 createRoot 的 onUncaughtError/onCaughtError 签名中，
// errorInfo 类型为 { componentStack?: string | undefined }（可选属性）。
// 项目开启了 exactOptionalPropertyTypes: true，故不引入 ErrorInfo 类型，
// 改为内联匹配 React 期望的可选属性签名。
const onUncaughtError = (
  error: unknown,
  errorInfo: { componentStack?: string | undefined }
) => {
  const err = error instanceof Error ? error : new Error(String(error))
  const stack = errorInfo.componentStack ?? ''
  logger.error('React uncaught error', {
    message: err.message,
    componentStack: stack,
  })
  Sentry.captureException(err, {
    contexts: { react: { componentStack: stack } },
  })
}

const onCaughtError = (
  error: unknown,
  errorInfo: { componentStack?: string | undefined }
) => {
  // 被 ErrorBoundary 捕获的错误 —— ErrorBoundary 自身已渲染降级 UI，
  // 此处仅记录与上报，避免重复弹窗打扰用户。
  const err = error instanceof Error ? error : new Error(String(error))
  const stack = errorInfo.componentStack ?? ''
  logger.warn('React caught error (handled by ErrorBoundary)', {
    message: err.message,
    componentStack: stack,
  })
  Sentry.captureException(err, {
    level: 'warning',
    contexts: { react: { componentStack: stack } },
  })
}

// window 级错误兜底：捕获事件处理器与异步回调中的非 Promise 异常
window.addEventListener('error', event => {
  // event.error 可能不存在（如跨域脚本错误仅返回 'Script error.'）
  const error = event.error ?? new Error(event.message)
  logger.error('Window error', {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  })
  Sentry.captureException(error)
})

// 未处理的 Promise rejection —— async/await 调用链中未捕获的 reject
window.addEventListener('unhandledrejection', event => {
  const reason = event.reason
  const error =
    reason instanceof Error
      ? reason
      : new Error(`Unhandled rejection: ${String(reason)}`)
  logger.error('Unhandled promise rejection', {
    reason: String(reason),
  })
  Sentry.captureException(error)
})

ReactDOM.createRoot(document.getElementById('root') as HTMLElement, {
  // React 19 错误回调：分别处理「未被任何 ErrorBoundary 捕获」与「被 ErrorBoundary 捕获」两类错误
  onUncaughtError,
  onCaughtError,
}).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
      <Suspense fallback={null}>
        <ReactQueryDevtools initialIsOpen={false} />
      </Suspense>
    </QueryClientProvider>
  </StrictMode>
)
