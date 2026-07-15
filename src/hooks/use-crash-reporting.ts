import { useEffect } from 'react'
import { commands } from '@/lib/tauri-bindings'
import { isSentryEnabled, setSentryConsent } from '@/lib/sentry'
import {
  useCrashReportStore,
  type CrashReportState,
} from '@/store/crash-report-store'
import { logger } from '@/lib/logger'

/**
 * useCrashReporting —— 管理 Sentry consent 与 Rust 崩溃报告处理。
 *
 * Sentry 在 main.tsx 早期初始化（React 渲染之前），以便捕获启动错误。
 * 本 hook 控制 consent 网关：
 *
 * 流程：
 * 1. 若 DSN 未配置 → 清理任何崩溃文件，跳过
 * 2. 加载 preferences → 检查 crash_reporting_consent
 * 3. consent 为 true  → setSentryConsent(true) —— 开始发送事件
 * 4. consent 为 false → setSentryConsent(false) —— 丢弃事件
 * 5. consent 为 null  → 保持网关关闭，存在崩溃时显示对话框
 * 6. 检查 Rust 崩溃文件（由后端 panic hook 写入）：
 *    - 崩溃存在 + consent true  → 删除文件（Rust Sentry 已发送）
 *    - 崩溃存在 + consent null  → 弹出 consent 对话框并展示崩溃详情
 *    - 崩溃存在 + consent false → 静默删除文件
 *
 * 注意：当 consent 为 true 时，Rust Sentry SDK 的 `before_send` 网关
 * 已开启（在 setup() 中从 preferences 初始化），因此 panic 事件在崩溃
 * 发生时就被立即发送。前端无需通过 captureMessage 重复发送 ——
 * 那样会造成重复事件。
 *
 * 副作用：
 *  - 读取并修改崩溃报告文件（通过 Tauri commands）
 *  - 更新 crash-report-store 触发 CrashReportDialog 显示
 *
 * 使用场景：仅在根组件（App.tsx）顶层调用一次。
 *
 * @see src/lib/sentry.ts — Sentry 初始化与 consent 网关实现
 * @see src/store/crash-report-store.ts — 崩溃报告 UI 状态
 * @see src/queries/preferences.ts — preferences 数据源
 */
export function useCrashReporting(): void {
  const setCrashReportDialogOpen = useCrashReportStore(
    (state: CrashReportState) => state.setCrashReportDialogOpen
  )
  const setPendingCrashReport = useCrashReportStore(
    (state: CrashReportState) => state.setPendingCrashReport
  )

  useEffect(() => {
    void (async () => {
      // 若 DSN 未配置，崩溃上报不可用
      if (!isSentryEnabled()) {
        // 清理上一会话遗留的崩溃文件
        try {
          await commands.deleteCrashReport()
        } catch {
          // 忽略错误 —— 文件可能不存在
        }
        return
      }

      // 1. 加载 preferences 检查 consent
      let consent: boolean | null = null
      try {
        const result = await commands.loadPreferences()
        if (result.status === 'ok') {
          consent = result.data.crash_reporting_consent
        }
      } catch (error) {
        logger.warn('Failed to load preferences for crash reporting', {
          error,
        })
      }

      // 2. 将 consent 应用到 Sentry 的 beforeSend 网关。
      //    Sentry 已初始化（在 main.tsx 中），此处只需开启或关闭事件提交网关。
      if (consent === true) {
        setSentryConsent(true)
      } else if (consent === false) {
        setSentryConsent(false)
      }
      // consent === null → 保持网关关闭，等待对话框

      // 3. 检查 Rust 崩溃文件（由 panic hook 写入）
      try {
        const crashResult = await commands.readCrashReport()
        if (crashResult.status === 'ok' && crashResult.data) {
          const crashData = crashResult.data

          if (consent === true) {
            // 已授予 consent —— Rust Sentry 已在崩溃发生时发送过 panic
            // 事件（CONSENT_STATE 在 setup() 中从 preferences 初始化）。
            // 此处只需删除崩溃文件。
            await commands.deleteCrashReport()
            logger.info(
              'Crash file deleted (Rust Sentry already sent the event)'
            )
          } else if (consent === null) {
            // consent 尚未询问 —— 显示对话框并展示崩溃详情。
            // Rust Sentry 已丢弃该事件(崩溃时 consent 为 null),
            // 因此若用户在 CrashReportDialog 中授予 consent,
            // 将通过 captureMessage 发送。
            //
            // 已知问题:consent 为 null 时崩溃文件不会被删除,若用户每次
            // 关闭对话框而不做选择,下次启动会重复弹窗。缓解措施:下方对
            // 超过 7 天的崩溃文件做自动清理,避免无限堆积陈旧崩溃报告。
            // 完整修复需在 CrashReportDialog 中提供"忽略本次"选项并显式
            // 删除文件(见 TODO)。
            const SEVEN_DAYS_IN_SECONDS = 7 * 24 * 60 * 60
            const isStale =
              crashData.timestamp !== null &&
              Date.now() / 1000 - crashData.timestamp > SEVEN_DAYS_IN_SECONDS

            if (isStale) {
              // 崩溃报告已过期(超过 7 天),静默删除避免重复弹窗
              await commands.deleteCrashReport()
              logger.info('Stale crash report deleted (older than 7 days)')
            } else {
              setPendingCrashReport(crashData)
              setCrashReportDialogOpen(true)
              logger.info('Crash report pending — showing consent dialog')
            }
            // TODO: 在 CrashReportDialog 中增加"忽略本次"按钮,
            //       点击后调用 commands.deleteCrashReport() 删除崩溃文件,
            //       并设置一个临时标记避免本次启动再次弹窗。
          } else {
            // consent 被拒绝 —— 静默删除
            await commands.deleteCrashReport()
            logger.debug('Crash report deleted (consent denied)')
          }
        }
      } catch (error) {
        logger.warn('Failed to check crash report', { error })
      }
    })()
  }, [setCrashReportDialogOpen, setPendingCrashReport])
}
