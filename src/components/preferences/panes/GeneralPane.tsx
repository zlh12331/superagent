/**
 * GeneralPane — 通用设置分区（生产版本）。
 *
 * 架构位置：被生产版本的 PreferencesDialog 渲染（与 mock 版本 GeneralSettingsPane
 * 在 SettingsPanes.tsx 中并存）。生产版本通过 TanStack Query 持久化到 Rust 后端，
 * 并集成 Tauri autostart 插件管理开机自启。
 *
 * 渲染逻辑：
 *  - 键盘快捷键区：ShortcutPicker 选择快速面板全局快捷键
 *    - 从 commands.getDefaultQuickPaneShortcut() 获取后端默认值（staleTime: Infinity）
 *    - 切换时先注册新快捷键，成功后再持久化偏好，失败则回滚
 *  - 系统区：Switch 开关控制开机自启
 *    - 通过 Tauri autostart 插件（enable/disable/isEnabled）管理
 *    - 使用 TanStack Query 缓存 autostart 状态，变更后 invalidateQueries 刷新
 *  - 示例设置区：Input + Switch（演示本地状态，不持久化）
 *
 * 状态依赖：
 *  - usePreferences() 读取后端持久化的 quick_pane_shortcut
 *  - useSavePreferences() 提供 mutateAsync 持久化偏好
 *  - useQuery(['default-quick-pane-shortcut']) 获取后端默认快捷键
 *  - useQuery(['autostart', 'is-enabled']) 获取开机自启状态
 *  - exampleText / exampleToggle：本地 useState（示例，不持久化）
 *
 * 副作用：
 *  - handleShortcutChange：
 *    1. 调用 commands.updateQuickPaneShortcut(newShortcut) 注册新快捷键
 *    2. 注册失败：toast.error 提示，return（不持久化）
 *    3. 注册成功：savePreferences.mutateAsync 持久化偏好
 *    4. 持久化失败：调用 commands.updateQuickPaneShortcut(oldShortcut) 回滚
 *    5. 回滚失败：toast.error 提示「后端与偏好不同步」（严重错误）
 *  - handleAutostartToggle：enable/disable autostart + invalidateQueries 刷新缓存
 *
 * 设计决策：
 *  - 快捷键更新采用「先注册后持久化」策略，确保后端注册成功才保存偏好
 *  - 持久化失败时回滚后端注册，保证状态一致性
 *  - 回滚失败时明确提示「不同步」，引导用户手动处理
 *  - autostart 默认关闭，由用户主动开启（尊重用户选择）
 *  - defaultShortcut 查询使用 staleTime: Infinity，因为这是编译期常量永不变化
 *
 * @see src/components/preferences/ShortcutPicker.tsx — 快捷键选择器组件
 * @see src/queries/preferences.ts — 偏好持久化 TanStack Query hooks
 * @see src-tauri/src/lib.rs — DEFAULT_QUICK_PANE_SHORTCUT 后端默认值
 * @see src/components/preferences/panes/SettingsPanes.tsx — mock 版本 GeneralSettingsPane
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ShortcutPicker } from '../ShortcutPicker'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { usePreferences, useSavePreferences } from '@/queries/preferences'
import { commands } from '@/lib/tauri-bindings'
import { logger } from '@/lib/logger'
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'

export function GeneralPane() {
  const { t } = useTranslation()
  // 示例本地状态 — 不会持久化到磁盘
  // 添加持久化偏好的步骤：
  // 1. 在 Rust 和 TypeScript 的 AppPreferences 中都添加该字段
  // 2. 使用 usePreferencesManager() 和 updatePreferences()
  const [exampleText, setExampleText] = useState('Example value')
  const [exampleToggle, setExampleToggle] = useState(true)

  // 加载键盘快捷键偏好
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()

  // 从后端获取默认快捷键
  const { data: defaultShortcut } = useQuery({
    queryKey: ['default-quick-pane-shortcut'],
    queryFn: async () => {
      return await commands.getDefaultQuickPaneShortcut()
    },
    staleTime: Infinity, // 永不重新获取 — 这是一个常量
  })

  const handleShortcutChange = async (newShortcut: string | null) => {
    if (!preferences) return

    // 保存旧快捷键，保存失败时用于回滚
    const oldShortcut = preferences.quick_pane_shortcut

    logger.info('Updating quick pane shortcut', { oldShortcut, newShortcut })

    // 先尝试注册新快捷键
    const result = await commands.updateQuickPaneShortcut(newShortcut)

    if (result.status === 'error') {
      logger.error('Failed to register shortcut', { error: result.error })
      toast.error(t('toast.error.shortcutFailed'), {
        description: result.error.message,
      })
      return
    }

    // 注册成功后，尝试保存偏好
    try {
      await savePreferences.mutateAsync({
        ...preferences,
        quick_pane_shortcut: newShortcut,
      })
    } catch {
      // 保存失败 — 回滚后端注册
      logger.warn('Save failed, rolling back shortcut registration', {
        oldShortcut,
        newShortcut,
      })

      const rollbackResult = await commands.updateQuickPaneShortcut(oldShortcut)

      if (rollbackResult.status === 'error') {
        logger.error(
          'Rollback failed - backend and preferences are out of sync',
          {
            error: rollbackResult.error,
            attemptedShortcut: newShortcut,
            originalShortcut: oldShortcut,
          }
        )
        toast.error(t('toast.error.shortcutRestoreFailed'), {
          description: t('toast.error.shortcutRestoreDescription'),
        })
      } else {
        logger.info('Successfully rolled back shortcut registration')
      }
    }
  }

  // 开机自启动 — 默认关闭，由用户在偏好中开启
  const queryClient = useQueryClient()

  const autostartQuery = useQuery({
    queryKey: ['autostart', 'is-enabled'],
    queryFn: async () => {
      return await isAutostartEnabled()
    },
  })

  const autostartEnabled = autostartQuery.data ?? false

  const handleAutostartToggle = async (enabled: boolean) => {
    try {
      if (enabled) {
        await enableAutostart()
      } else {
        await disableAutostart()
      }
      await queryClient.invalidateQueries({
        queryKey: ['autostart', 'is-enabled'],
      })
    } catch (error) {
      logger.error('Failed to toggle autostart', { error, enabled })
      toast.error(
        enabled
          ? t('preferences.general.launchOnBootEnableFailed')
          : t('preferences.general.launchOnBootDisableFailed')
      )
    }
  }

  return (
    <div className="space-y-6">
      <SettingsSection title={t('preferences.general.keyboardShortcuts')}>
        <SettingsField
          label={t('preferences.general.quickPaneShortcut')}
          description={t('preferences.general.quickPaneShortcutDescription')}
        >
          <ShortcutPicker
            value={preferences?.quick_pane_shortcut ?? null}
            // 兜底值与 src-tauri/src/lib.rs 中的 DEFAULT_QUICK_PANE_SHORTCUT 保持一致
            defaultValue={defaultShortcut ?? 'CommandOrControl+Shift+.'}
            onChange={handleShortcutChange}
            disabled={!preferences || savePreferences.isPending}
          />
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t('preferences.general.system')}>
        <SettingsField
          label={t('preferences.general.launchOnBoot')}
          description={t('preferences.general.launchOnBootDescription')}
        >
          <div className="flex items-center space-x-2">
            <Switch
              id="autostart-toggle"
              checked={autostartEnabled}
              onCheckedChange={handleAutostartToggle}
              disabled={autostartQuery.isLoading}
            />
            <Label htmlFor="autostart-toggle" className="text-sm">
              {autostartEnabled ? t('common.enabled') : t('common.disabled')}
            </Label>
          </div>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t('preferences.general.exampleSettings')}>
        <SettingsField
          label={t('preferences.general.exampleText')}
          description={t('preferences.general.exampleTextDescription')}
        >
          <Input
            value={exampleText}
            onChange={e => setExampleText(e.target.value)}
            placeholder={t('preferences.general.exampleTextPlaceholder')}
          />
        </SettingsField>

        <SettingsField
          label={t('preferences.general.exampleToggle')}
          description={t('preferences.general.exampleToggleDescription')}
        >
          <div className="flex items-center space-x-2">
            <Switch
              id="example-toggle"
              checked={exampleToggle}
              onCheckedChange={setExampleToggle}
            />
            <Label htmlFor="example-toggle" className="text-sm">
              {exampleToggle ? t('common.enabled') : t('common.disabled')}
            </Label>
          </div>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
