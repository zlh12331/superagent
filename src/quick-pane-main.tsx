/**
 * @file 快捷面板（quick-pane）窗口的入口文件。
 *
 * 架构位置：Tauri 子窗口的独立 Vite 入口，与主窗口 main.tsx 隔离渲染上下文。
 * 职责：挂载 QuickPaneApp 到独立窗口的 #root，并复用主应用的 Sentry/ErrorBoundary。
 *
 * 注意：此处不挂载 TanStack Query Provider（QuickPaneApp 自行管理其查询上下文），
 *   仅引入 i18n/config 完成静态文案初始化。
 */

import ReactDOM from 'react-dom/client'
import { StrictMode } from 'react'
import QuickPaneApp from './components/quick-pane/QuickPaneApp'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initSentry } from './lib/sentry'
import './i18n/config'
import './quick-pane.css'

// 在渲染前初始化 Sentry，以便捕获快捷面板窗口中的运行时错误。
// DSN 与同意门控由 initSentry 内部处理。
initSentry()

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QuickPaneApp />
    </ErrorBoundary>
  </StrictMode>
)
