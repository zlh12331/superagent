/**
 * AppearancePane — 外观设置分区（生产版本）。
 *
 * 架构位置：被生产版本的 PreferencesDialog 渲染（与 mock 版本 AppearanceSettingsPane
 * 在 SettingsPanes.tsx 中并存）。生产版本通过 TanStack Query 持久化到 Rust 后端，
 * 并支持 i18next 动态切换语言。
 *
 * 渲染逻辑：
 *  - 语言区：Select 下拉框（system / English / 中文）
 *    - system 选项：检测系统 locale，自动选择匹配的语言
 *    - 切换时先 loadLanguageAsync 懒加载语言包，再 i18n.changeLanguage 应用
 *  - 主题区：Select 下拉框（light / dark / system）
 *    - 切换时立即更新 ThemeProvider（即时 UI 反馈）
 *    - 同时通过 savePreferences 持久化到 Rust 后端
 *
 * 状态依赖：
 *  - useTheme() 提供 theme/setTheme（来自 ThemeProviderContext）
 *  - usePreferences() 读取后端持久化的偏好（language / theme）
 *  - useSavePreferences() 提供 mutate 方法持久化偏好
 *  - savePreferences.isPending 时禁用 Select，避免重复提交
 *
 * 副作用：
 *  - handleThemeChange：setTheme 即时更新 + savePreferences.mutate 持久化
 *  - handleLanguageChange：
 *    1. 解析语言值（system → 检测系统 locale；其他 → 直接使用）
 *    2. loadLanguageAsync 动态 import 语言包
 *    3. i18n.changeLanguage 应用语言
 *    4. savePreferences.mutate 持久化语言偏好
 *    5. 失败时 toast.error 提示并 return（不持久化）
 *
 * 设计决策：
 *  - 语言切换先加载语言包再 changeLanguage，避免渲染时翻译缺失
 *  - 主题切换采用乐观更新（立即 setTheme），用户无需等待后端响应
 *  - system 语言选项映射到 null 值存储，便于后端区分「跟随系统」与「指定语言」
 *
 * @see src/hooks/use-theme.ts — 主题上下文 hook
 * @see src/queries/preferences.ts — 偏好持久化 TanStack Query hooks
 * @see src/i18n/index.ts — 语言包懒加载与可用语言列表
 * @see src/components/preferences/panes/SettingsPanes.tsx — mock 版本 AppearanceSettingsPane
 */

import { useTranslation } from 'react-i18next'
import { locale } from '@tauri-apps/plugin-os'
import { toast } from 'sonner'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useTheme } from '@/hooks/use-theme'
import { SettingsField, SettingsSection } from '../shared/SettingsComponents'
import { usePreferences, useSavePreferences } from '@/queries/preferences'
import { availableLanguages, loadLanguageAsync } from '@/i18n'
import { logger } from '@/lib/logger'

/** 语言显示名称映射 — 使用原生名称（非翻译）便于用户识别 */
const languageNames: Record<string, string> = {
  en: 'English',
  zh: '中文',
}

export function AppearancePane() {
  const { t, i18n } = useTranslation()
  const { theme, setTheme } = useTheme()
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()

  const handleThemeChange = (value: 'light' | 'dark' | 'system') => {
    // 立即更新主题提供者以获得即时 UI 反馈
    setTheme(value)

    // 将主题偏好持久化到磁盘，同时保留其他偏好
    if (preferences) {
      savePreferences.mutate({ ...preferences, theme: value })
    }
  }

  const handleLanguageChange = async (value: string) => {
    const language = value === 'system' ? null : value

    try {
      // 先加载语言包（通过动态 import 懒加载）
      // 确保 changeLanguage 触发重渲染前翻译已就绪
      if (language) {
        await loadLanguageAsync(language)
        await i18n.changeLanguage(language)
      } else {
        // 选择了系统语言 — 检测并应用系统区域设置
        const systemLocale = await locale()
        const langCode = systemLocale?.split('-')[0]?.toLowerCase() ?? 'en'
        const targetLang = availableLanguages.includes(langCode)
          ? langCode
          : 'en'
        await loadLanguageAsync(targetLang)
        await i18n.changeLanguage(targetLang)
      }
    } catch (error) {
      logger.error('Failed to change language', { error })
      toast.error(t('toast.error.generic'))
      return
    }

    // 将语言偏好持久化到磁盘
    if (preferences) {
      savePreferences.mutate({ ...preferences, language })
    }
  }

  // 确定下拉选择框当前的语言值
  const currentLanguageValue = preferences?.language ?? 'system'

  return (
    <div className="space-y-6">
      <SettingsSection title={t('preferences.appearance.language')}>
        <SettingsField
          label={t('preferences.appearance.language')}
          description={t('preferences.appearance.languageDescription')}
        >
          <Select
            value={currentLanguageValue}
            onValueChange={handleLanguageChange}
            disabled={savePreferences.isPending}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">
                {t('preferences.appearance.language.system')}
              </SelectItem>
              {availableLanguages.map(lang => (
                <SelectItem key={lang} value={lang}>
                  {languageNames[lang] ?? lang}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsSection>

      <SettingsSection title={t('preferences.appearance.theme')}>
        <SettingsField
          label={t('preferences.appearance.colorTheme')}
          description={t('preferences.appearance.colorThemeDescription')}
        >
          <Select
            value={theme}
            onValueChange={handleThemeChange}
            disabled={savePreferences.isPending}
          >
            <SelectTrigger>
              <SelectValue
                placeholder={t('preferences.appearance.selectTheme')}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="light">
                {t('preferences.appearance.theme.light')}
              </SelectItem>
              <SelectItem value="dark">
                {t('preferences.appearance.theme.dark')}
              </SelectItem>
              <SelectItem value="system">
                {t('preferences.appearance.theme.system')}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingsField>
      </SettingsSection>
    </div>
  )
}
