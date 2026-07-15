/**
 * AdvancedPane — 高级设置分区（生产版本）。
 *
 * 架构位置：被生产版本的 PreferencesDialog 渲染（与 mock 版本 AdvancedSettingsPane
 * 在 SettingsPanes.tsx 中并存，生产版本通过 TanStack Query 持久化到 Rust 后端）。
 *
 * 渲染逻辑：
 *  - 示例设置区：Switch 开关 + Select 下拉框（演示本地状态，不持久化）
 *  - 崩溃报告区：Switch 开关，控制 Sentry 崩溃报告授权
 *    - 从 commands.loadPreferences() 加载当前授权状态
 *    - 切换时调用 commands.savePreferences() 持久化，并调用 setSentryConsent() 同步运行时
 *    - 未配置 Sentry DSN 时禁用开关并显示提示
 *  - API 配置区：嵌入 ApiConfigForm 组件
 *
 * 状态依赖：
 *  - exampleAdvancedToggle / exampleDropdown：本地 useState（示例，不持久化）
 *  - crashReportingEnabled：本地 useState，useEffect 初始化时从后端加载
 *  - sentryConfigured：isSentryEnabled() 同步返回值（检查 VITE_SENTRY_DSN 环境变量）
 *
 * 副作用：
 *  - useEffect：组件挂载时异步加载崩溃报告授权状态
 *  - handleCrashReportingToggle：异步保存偏好 + 同步 Sentry 运行时 + toast 提示
 *
 * 设计决策：
 *  - 崩溃报告授权采用「双重门控」：Rust 偏好文件 + 前端 Sentry 运行时状态
 *    两者必须同步，避免授权状态不一致
 *  - Sentry 未配置时禁用开关，避免用户误以为崩溃报告已启用
 *  - 示例设置项保留用于演示本地状态模式，添加持久化字段的步骤见内联注释
 *
 * @see src/lib/sentry.ts — Sentry 初始化与授权管理
 * @see src/components/preferences/panes/ApiConfigForm.tsx — 嵌入的 API 配置表单
 * @see src/components/preferences/panes/SettingsPanes.tsx — mock 版本 AdvancedSettingsPane
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { ApiConfigForm } from './ApiConfigForm'
import { commands } from '@/lib/tauri-bindings'
import { isSentryEnabled, setSentryConsent } from '@/lib/sentry'
import { logger } from '@/lib/logger'

export function AdvancedPane() {
  const { t } = useTranslation()
  // 示例本地状态 — 不会持久化到磁盘
  // 添加持久化偏好的步骤：
  // 1. 在 Rust 和 TypeScript 的 AppPreferences 中都添加该字段
  // 2. 使用 usePreferencesManager() 和 updatePreferences()
  const [exampleAdvancedToggle, setExampleAdvancedToggle] = useState(false)
  const [exampleDropdown, setExampleDropdown] = useState('option1')
  const [crashReportingEnabled, setCrashReportingEnabled] = useState(false)
  const sentryConfigured = isSentryEnabled()

  // 从持久化偏好中加载崩溃报告授权状态
  useEffect(() => {
    void (async () => {
      try {
        const result = await commands.loadPreferences()
        if (result.status === 'ok') {
          setCrashReportingEnabled(result.data.crash_reporting_consent === true)
        }
      } catch (error) {
        logger.error('Failed to load crash reporting consent', { error })
      }
    })()
  }, [])

  const handleCrashReportingToggle = async (enabled: boolean) => {
    try {
      const loadResult = await commands.loadPreferences()
      if (loadResult.status === 'ok') {
        await commands.savePreferences({
          ...loadResult.data,
          crash_reporting_consent: enabled,
        })
      }
      setCrashReportingEnabled(enabled)
      if (enabled) {
        setSentryConsent(true)
        toast.success(t('preferences.advanced.crashReporting.enabled'))
      } else {
        setSentryConsent(false)
        toast.info(t('preferences.advanced.crashReporting.disabled'))
      }
    } catch (error) {
      logger.error('Failed to toggle crash reporting', { error })
      toast.error(t('preferences.advanced.crashReporting.toggleError'))
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title={t('preferences.advanced.title')}>
        <SettingsField
          label={t('preferences.advanced.toggle')}
          description={t('preferences.advanced.toggleDescription')}
        >
          <div className="flex items-center space-x-2">
            <Switch
              id="example-advanced-toggle"
              checked={exampleAdvancedToggle}
              onCheckedChange={setExampleAdvancedToggle}
            />
            <Label htmlFor="example-advanced-toggle" className="text-sm">
              {exampleAdvancedToggle
                ? t('common.enabled')
                : t('common.disabled')}
            </Label>
          </div>
        </SettingsField>

        <SettingsField
          label={t('preferences.advanced.dropdown')}
          description={t('preferences.advanced.dropdownDescription')}
        >
          <Select value={exampleDropdown} onValueChange={setExampleDropdown}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="option1">
                {t('preferences.advanced.option1')}
              </SelectItem>
              <SelectItem value="option2">
                {t('preferences.advanced.option2')}
              </SelectItem>
              <SelectItem value="option3">
                {t('preferences.advanced.option3')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t('preferences.advanced.crashReporting.title')}>
        <SettingsField
          label={t('preferences.advanced.crashReporting.description')}
          description={t(
            'preferences.advanced.crashReporting.consentDescription'
          )}
        >
          <div className="flex items-center space-x-2">
            <Switch
              id="crash-reporting-toggle"
              checked={crashReportingEnabled}
              onCheckedChange={handleCrashReportingToggle}
              disabled={!sentryConfigured}
            />
            <Label htmlFor="crash-reporting-toggle" className="text-sm">
              {crashReportingEnabled
                ? t('common.enabled')
                : t('common.disabled')}
            </Label>
          </div>
        </SettingsField>
        {!sentryConfigured && (
          <p className="text-xs text-muted-foreground">
            {t('preferences.advanced.crashReporting.notConfigured')}
          </p>
        )}
      </SettingsSection>

      <ApiConfigForm />
    </div>
  )
}
