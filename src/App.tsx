/**
 * @file 应用根组件，承担主窗口的初始化与生命周期编排。
 *
 * 架构位置：渲染树顶层，被 main.tsx 挂载到 #root。
 * 职责：
 *  1. 启动命令系统、i18n、应用菜单、恢复文件清理等基础设施；
 *  2. 装配 ErrorBoundary → ThemeProvider → MainWindow 的层级；
 *  3. 在开发环境下挂载 Sentry 调试面板用于 E2E 测试触发。
 *
 * 依赖项：
 *  - TanStack Query（通过 usePreferences 读取用户偏好）；
 *  - Tauri 后端（通过 lib/commands、lib/menu 等模块间接调用）；
 *  - Sentry（在 lib/sentry 中初始化）。
 */

import { useEffect, useState } from 'react'
import * as Sentry from '@sentry/react'
import { MotionConfig } from 'motion/react'
import { initializeCommandSystem } from './lib/commands'
import { buildAppMenu, setupMenuLanguageListener } from './lib/menu'
import { initializeLanguage } from './i18n/language-init'
import { logger } from './lib/logger'
import { cleanupOldFiles } from './lib/recovery'
import './App.css'
import { MainWindow } from './components/layout/MainWindow'
import { ThemeProvider } from './components/ThemeProvider'
import { ErrorBoundary } from './components/ErrorBoundary'
// LayerManager：全局层级栈管理（对齐原型 LayerManager 单例的 closeAll 能力）
import { LayerManagerProvider } from './lib/layer-manager-context'
import { useSquareCornersEffect } from './hooks/useSquareCornersEffect'
import { useDeepLink } from './hooks/use-deep-link'
import { useCrashReporting } from './hooks/use-crash-reporting'
import { useAutoUpdater } from './hooks/use-auto-updater'
import { isSentryInitialized } from './lib/sentry'
import { usePreferences } from './queries/preferences'

/**
 * Sentry E2E 测试调试面板 — 仅在开发模式下显示。
 *
 * 用途：在 E2E 测试中通过点击按钮手动触发 Sentry 事件，
 *   以验证错误捕获链路（initSentry → captureMessage / unhandled rejection）是否正常工作。
 *
 * 设计原因：生产构建必须包含此面板代码以保持调用点稳定，
 *   但通过 `import.meta.env.DEV` 早返回保证生产环境零渲染开销。
 */
function SentryDebugPanel() {
  const [lastEvent, setLastEvent] = useState<string>('')

  const triggerJsError = () => {
    const msg = `E2E JS error @ ${new Date().toISOString()}`
    Sentry.captureMessage(msg, 'error')
    setLastEvent(`Sent: ${msg}`)
    logger.info('E2E: Triggered JS Sentry event', { msg })
  }

  const triggerUnhandledRejection = () => {
    const msg = `E2E unhandled rejection @ ${new Date().toISOString()}`
    Promise.reject(new Error(msg))
    setLastEvent(`Triggered: ${msg}`)
  }

  if (!import.meta.env.DEV) return null

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 8,
        right: 8,
        zIndex: 9999,
        background: 'rgba(0,0,0,0.85)',
        color: '#0f0',
        padding: 12,
        borderRadius: 8,
        fontFamily: 'monospace',
        fontSize: 12,
        maxWidth: 320,
      }}
    >
      <div style={{ fontWeight: 'bold', marginBottom: 8 }}>
        Sentry E2E Debug
      </div>
      <div>Sentry init: {isSentryInitialized() ? 'Yes' : 'No'}</div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        <button onClick={triggerJsError} style={{ fontSize: 11 }}>
          JS Error
        </button>
        <button onClick={triggerUnhandledRejection} style={{ fontSize: 11 }}>
          Unhandled Rejection
        </button>
      </div>
      {lastEvent && (
        <div style={{ marginTop: 6, color: '#ff0', fontSize: 10 }}>
          {lastEvent}
        </div>
      )}
    </div>
  )
}

/**
 * 应用根组件，负责启动期初始化与全局副作用编排。
 *
 * 副作用清单（按 React 渲染顺序触发）：
 *  - useSquareCornersEffect：根据偏好关闭某些控件的圆角；
 *  - useDeepLink：监听 tauri:// 深链跳转；
 *  - useCrashReporting：根据同意状态控制 Sentry 上报；
 *  - useAutoUpdater：检查应用更新。
 *
 * 启动期 useEffect 内顺序：
 *  1. initializeCommandSystem()：注册命令系统的所有命令；
 *  2. initializeLanguage(savedLanguage)：根据偏好或系统区域初始化 i18n；
 *  3. buildAppMenu() + setupMenuLanguageListener()：构建并响应菜单语言变化；
 *  4. cleanupOldFiles()：清理上次崩溃残留的恢复文件。
 *
 * 依赖 store/query：通过 usePreferences() 共享 TanStack Query 缓存的偏好数据，
 *   避免在此处再发起一次 IPC 调用。
 *
 * @returns 根渲染树：ErrorBoundary → ThemeProvider → MainWindow + SentryDebugPanel
 */
function App() {
  useSquareCornersEffect()
  useDeepLink()
  useCrashReporting()
  useAutoUpdater()

  // 复用 preferences 查询（由 TanStack Query 缓存），避免语言初始化时
  // 重复发起 IPC 调用。
  const { data: preferences } = usePreferences()

  // 启动时初始化命令系统、语言、菜单，并执行恢复文件清理
  useEffect(() => {
    logger.info('Frontend application starting up')
    initializeCommandSystem()
    logger.debug('Command system initialized')

    // 根据已保存的偏好或系统区域设置初始化语言
    const initLanguageAndMenu = async () => {
      try {
        const savedLanguage = preferences?.language ?? null

        // 初始化语言（无偏好时使用系统区域设置）
        await initializeLanguage(savedLanguage)

        // 使用已初始化的语言构建应用菜单
        await buildAppMenu()
        logger.debug('Application menu built')
        setupMenuLanguageListener()
      } catch (error) {
        logger.warn('Failed to initialize language or menu', { error })
      }
    }

    void initLanguageAndMenu()

    // 启动时清理旧的恢复文件
    cleanupOldFiles().catch(error => {
      logger.warn('Failed to cleanup old recovery files', { error })
    })

    // 携带上下文记录日志的示例
    logger.info('App environment', {
      isDev: import.meta.env.DEV,
      mode: import.meta.env.MODE,
    })
  }, [preferences?.language])

  return (
    <ErrorBoundary>
      <ThemeProvider>
        {/* MotionConfig：全局动画行为配置。
            reducedMotion="user" 让 motion/react 尊重系统「减少动态效果」设置，
            对前庭功能敏感用户友好，且无需手动探测 prefers-reduced-motion。
            - "user"：仅在用户系统开启「减少动态效果」时禁用动画
            - "always"：始终禁用（仅测试用）
            - "never"：始终启用动画（默认） */}
        <MotionConfig reducedMotion="user">
          {/* LayerManagerProvider：提供全局层级栈管理（closeAll 能力），
              与 MainWindow 的 Esc 协调器互补，不重叠职责 */}
          <LayerManagerProvider>
            <MainWindow />
            <SentryDebugPanel />
          </LayerManagerProvider>
        </MotionConfig>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
