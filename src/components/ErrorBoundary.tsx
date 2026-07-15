import { Component, type ErrorInfo, type ReactNode } from 'react'
import { saveCrashState } from '@/lib/recovery'
import { captureException } from '@/lib/sentry'
import { logger } from '@/lib/logger'
import i18n from '@/i18n/config'

/**
 * 自定义降级 UI 的渲染参数。
 * - error: 被捕获的错误对象,方便开发者展示具体错误信息
 * - reset: 重置 ErrorBoundary 状态的回调;调用后会重新渲染 children
 */
export interface ErrorBoundaryFallbackRenderArgs {
  error: Error
  reset: () => void
}

/**
 * fallback prop 类型:
 * - ReactNode: 直接渲染静态降级 UI
 * - 渲染函数: 接收 error 与 reset,返回动态降级 UI(推荐用于需要交互或错误信息的场景)
 */
export type ErrorBoundaryFallback =
  | ReactNode
  | ((args: ErrorBoundaryFallbackRenderArgs) => ReactNode)

interface Props {
  /** 需要被 ErrorBoundary 包裹的子树 */
  children: ReactNode
  /**
   * 可选:自定义降级 UI。
   * - 传入 React 节点时直接渲染
   * - 传入函数时会注入错误对象与重置回调,便于调用方实现"重试"等交互
   * 未传时回退到组件内置的全屏错误 UI(保持向后兼容)。
   */
  fallback?: ErrorBoundaryFallback
  /**
   * 可选:仅对默认(未传 fallback)的降级 UI 生效。
   * - true:容器使用 h-full w-full,适合嵌入到面板/卡片等局部容器内
   * - false(默认):容器使用 min-h-screen,适合顶层全屏降级
   */
  inline?: boolean
  /**
   * 可选:重置键。当此值变化时,ErrorBoundary 自动清除错误状态并重新渲染 children。
   * 典型用途:切换 thread/view 时自动恢复,避免前一视图的错误状态残留。
   */
  resetKey?: string | number
}

interface State {
  hasError: boolean
  error?: Error | undefined
  errorInfo?: ErrorInfo | undefined
}

/**
 * 应用级错误边界组件。
 *
 * 职责:
 * 1. 捕获子树渲染期间的同步错误,避免整屏白屏
 * 2. 上报 Sentry,并将崩溃快照写入恢复文件,便于下次启动恢复
 * 3. 渲染降级 UI;支持调用方通过 `fallback` prop 自定义局部 UI
 *
 * 嵌套支持:
 * 该组件基于 React 类组件实现,每个实例独立维护错误状态,
 * 因此天然支持嵌套——子级 ErrorBoundary 优先捕获子树错误,
 * 只有当子级未渲染降级 UI 时才会冒泡到父级。
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(error: Error): State {
    // 捕获到错误后切换到降级 UI 渲染分支
    return {
      hasError: true,
      error,
    }
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('Application crashed', {
      error: error.message,
      stack: error.stack,
    })

    // 上报到 Sentry(未初始化时为 no-op,不会抛错)
    captureException(error)

    this.setState({ errorInfo })

    // 异步保存崩溃状态,不阻塞错误 UI 的渲染
    this.saveCrashData(error, errorInfo)
  }

  override componentDidUpdate(prevProps: Props) {
    // resetKey 变化时自动清除错误状态，重新渲染 children。
    // 典型场景：用户切换 thread/view 后，前一视图的错误不应残留。
    if (
      this.state.hasError &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.setState({ hasError: false, error: undefined, errorInfo: undefined })
    }
  }

  private async saveCrashData(error: Error, errorInfo: ErrorInfo) {
    try {
      // 收集基础应用状态,后续可按需扩展
      const appState = {
        url: window.location.href,
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString(),
        // 后续可补充更多上下文,例如:
        // currentUser: getCurrentUser(),
        // activeFeatures: getActiveFeatures(),
      }

      await saveCrashState(appState, {
        error: error.message,
        stack: error.stack || 'No stack trace available',
        componentStack: errorInfo.componentStack || undefined,
      })
      // 确认保存完成 —— await 之后才记录,保证日志反映真实的保存结果
      logger.info('Crash state saved successfully')
    } catch (saveError) {
      // 错误边界内部不应再向上抛错,记录日志即可
      logger.error('Failed to save crash data', { saveError })
    }
  }

  private handleReload = () => {
    window.location.reload()
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: undefined, errorInfo: undefined })
  }

  override render() {
    if (!this.state.hasError) {
      return this.props.children
    }

    const { fallback, inline } = this.props
    const error = this.state.error ?? new Error('Unknown error')
    const reset = this.handleReset

    // 优先使用调用方传入的自定义降级 UI
    if (fallback !== undefined) {
      if (typeof fallback === 'function') {
        // 渲染函数:注入错误对象与重置回调
        return fallback({ error, reset })
      }
      // 静态 React 节点:直接返回
      return fallback
    }

    // 未传 fallback:渲染内置默认 UI
    // inline 模式下使用 h-full w-full 以适配面板/卡片内嵌场景;
    // 否则保持原有的 min-h-screen 全屏布局,确保向后兼容。
    const containerClassName = inline
      ? 'flex h-full w-full flex-col items-center justify-center bg-background p-4'
      : 'flex min-h-screen flex-col items-center justify-center bg-background p-8'

    return (
      <div className={containerClassName}>
        <div className="w-full max-w-md text-center">
          <div className="mb-6">
            <div className="mx-auto mb-4 h-16 w-16 rounded-full bg-destructive/10 flex items-center justify-center">
              <svg
                className="h-8 w-8 text-destructive"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L3.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-foreground mb-2">
              {i18n.t('errorBoundary.title')}
            </h1>
            <p className="text-muted-foreground mb-6">
              {i18n.t('errorBoundary.description')}
            </p>
          </div>

          <div className="space-y-3">
            <button
              onClick={this.handleReload}
              className="w-full px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
            >
              {i18n.t('errorBoundary.reload')}
            </button>

            <button
              onClick={this.handleReset}
              className="w-full px-4 py-2 bg-secondary text-secondary-foreground rounded-md hover:bg-secondary/90 transition-colors"
            >
              {i18n.t('errorBoundary.tryAgain')}
            </button>
          </div>

          {import.meta.env.DEV && this.state.error && (
            <details className="mt-6 text-left">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                {i18n.t('errorBoundary.errorDetails')}
              </summary>
              <div className="mt-2 p-3 bg-muted rounded-md text-xs font-mono">
                <div className="text-destructive font-semibold mb-1">
                  {this.state.error.name}: {this.state.error.message}
                </div>
                {this.state.error.stack && (
                  <pre className="whitespace-pre-wrap text-muted-foreground overflow-auto">
                    {this.state.error.stack}
                  </pre>
                )}
              </div>
            </details>
          )}
        </div>
      </div>
    )
  }
}
