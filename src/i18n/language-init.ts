/**
 * @file 语言初始化工具：在应用启动时检测并应用用户的偏好语言。
 *
 * 架构位置：在 `src/main.tsx` 早期（React 渲染之前）调用 `initializeLanguage`，
 *   确保 i18next 实例在挂载时已加载正确的语言包，避免首屏闪烁。
 *
 * 设计要点：
 *  - 优先级：用户偏好 > 系统 locale > 中文（fallback）；
 *  - 非默认语言（en）通过 `loadLanguageAsync` 懒加载，避免主 bundle 膨胀；
 *  - 任何异常都确保最终有语言设置，不会让 UI 进入"无翻译"状态。
 *
 * @see src/i18n/config.ts — i18n 实例与资源加载实现
 * @see src/main.tsx — 调用入口
 */
import { locale } from '@tauri-apps/plugin-os'
import i18n, { availableLanguages, loadLanguageAsync } from './config'
import { logger } from '@/lib/logger'

/**
 * 初始化应用语言。
 *
 * 优先级：
 * 1. 用户保存的语言偏好（若已设置）
 * 2. 系统 locale（若存在对应翻译）
 * 3. 中文（回退语言）
 *
 * 非默认语言在切换前会通过 `loadLanguageAsync` 懒加载，
 * 确保翻译 key 立即可用。
 *
 * 副作用：
 *  - 调用 i18n.changeLanguage 切换语言（触发 languageChanged 事件）
 *  - 通过 loadLanguageAsync 动态加载语言包 chunk
 *
 * @param savedLanguage - 用户在 preferences 中保存的语言偏好（null 表示未设置）
 * @returns Promise，在语言设置完成后 resolve
 */
export async function initializeLanguage(
  savedLanguage: string | null
): Promise<void> {
  try {
    if (savedLanguage) {
      // 用户显式设置了偏好
      if (availableLanguages.includes(savedLanguage)) {
        await loadLanguageAsync(savedLanguage)
        await i18n.changeLanguage(savedLanguage)
        logger.info('Language set from user preference', {
          language: savedLanguage,
        })
      } else {
        logger.warn('Saved language not available, using fallback', {
          savedLanguage,
          availableLanguages,
        })
        await i18n.changeLanguage('zh')
      }
      return
    }

    // 无保存的偏好，尝试检测系统 locale
    const systemLocale = await locale()
    logger.debug('Detected system locale', { systemLocale })

    if (systemLocale) {
      // 提取语言代码（例如 "en-US" → "en"）
      const parts = systemLocale.split('-')
      const langCode = (parts[0] ?? 'en').toLowerCase()

      if (availableLanguages.includes(langCode)) {
        await loadLanguageAsync(langCode)
        await i18n.changeLanguage(langCode)
        logger.info('Language set from system locale', {
          systemLocale,
          language: langCode,
        })
        return
      }

      logger.debug('System locale not available in translations', {
        systemLocale,
        langCode,
        availableLanguages,
      })
    }

    // 回退到中文（对齐原型默认语言）
    await i18n.changeLanguage('zh')
    logger.info('Language set to zh (fallback)')
  } catch (error) {
    logger.error('Failed to initialize language', { error })
    // 确保有语言设置
    await i18n.changeLanguage('zh')
  }
}
