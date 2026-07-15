import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import * as Sentry from '@sentry/react'
import { toast } from 'sonner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { commands } from '@/lib/tauri-bindings'
import { isSentryEnabled, setSentryConsent } from '@/lib/sentry'
import {
  useCrashReportStore,
  type CrashReportState,
} from '@/store/crash-report-store'
import { logger } from '@/lib/logger'

/**
 * CrashReportDialog — 崩溃报告的同意弹窗。
 *
 * 触发条件：
 * - 启动时发现 Rust 崩溃文件，且尚未询问过用户同意
 *
 * 操作：
 * - "发送报告"：保存 consent=true，初始化 Sentry，发送崩溃信息，删除崩溃文件
 * - "不发送"：保存 consent=false，删除崩溃文件
 *
 * 若 Sentry DSN 未配置，弹窗仍会显示（用于告知用户崩溃信息），
 * 但"发送报告"按钮会被禁用。
 */
export function CrashReportDialog() {
  const { t } = useTranslation()
  const open = useCrashReportStore(
    (state: CrashReportState) => state.crashReportDialogOpen
  )
  const setOpen = useCrashReportStore(
    (state: CrashReportState) => state.setCrashReportDialogOpen
  )
  const pendingCrashReport = useCrashReportStore(
    (state: CrashReportState) => state.pendingCrashReport
  )
  const setPendingCrashReport = useCrashReportStore(
    (state: CrashReportState) => state.setPendingCrashReport
  )
  const [handling, setHandling] = useState(false)

  const sentryConfigured = isSentryEnabled()

  const handleAllow = async () => {
    setHandling(true)
    try {
      // 保存同意偏好
      const loadResult = await commands.loadPreferences()
      if (loadResult.status === 'ok') {
        await commands.savePreferences({
          ...loadResult.data,
          crash_reporting_consent: true,
        })
      }

      // 打开 Sentry 的同意门 — 开始发送事件
      setSentryConsent(true)

      // 发送待处理的崩溃报告（若存在）
      if (pendingCrashReport) {
        Sentry.captureMessage(
          `Rust panic: ${pendingCrashReport.message}`,
          'fatal'
        )
      }

      // 删除崩溃文件
      await commands.deleteCrashReport()

      setPendingCrashReport(null)
      setOpen(false)
      toast.success(t('crashReport.consentGranted'))
    } catch (error) {
      logger.error('Failed to grant crash report consent', { error })
      toast.error(t('crashReport.consentError'))
    } finally {
      setHandling(false)
    }
  }

  const handleDeny = async () => {
    setHandling(true)
    try {
      // 保存同意偏好
      const loadResult = await commands.loadPreferences()
      if (loadResult.status === 'ok') {
        await commands.savePreferences({
          ...loadResult.data,
          crash_reporting_consent: false,
        })
      }

      // 删除崩溃文件
      await commands.deleteCrashReport()

      setPendingCrashReport(null)
      setOpen(false)
    } catch (error) {
      logger.error('Failed to deny crash report consent', { error })
      toast.error(t('crashReport.consentError'))
    } finally {
      setHandling(false)
    }
  }

  const handleOpenChange = (nextOpen: boolean) => {
    if (!handling) {
      setOpen(nextOpen)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('crashReport.title')}</DialogTitle>
          <DialogDescription>{t('crashReport.description')}</DialogDescription>
        </DialogHeader>

        {pendingCrashReport && (
          <div className="rounded-lg border p-3 space-y-1">
            <p className="text-sm font-medium">
              {t('crashReport.crashMessage')}
            </p>
            <p className="text-sm text-muted-foreground font-mono">
              {pendingCrashReport.message}
            </p>
            {pendingCrashReport.location && (
              <p className="text-xs text-muted-foreground">
                {pendingCrashReport.location}
              </p>
            )}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {t('crashReport.privacyNote')}
        </p>

        <DialogFooter>
          <Button variant="secondary" onClick={handleDeny} disabled={handling}>
            {t('crashReport.dontSend')}
          </Button>
          <Button
            onClick={handleAllow}
            disabled={handling || !sentryConfigured}
          >
            {t('crashReport.sendReport')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
