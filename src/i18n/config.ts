/**
 * @file i18n 配置中心。
 *
 * 职责：初始化 i18next + react-i18next，提供基础语言资源、懒加载机制、
 *   RTL 检测、语言列表查询等能力，供整个应用共享单一 i18n 实例。
 *
 * 架构位置：在 `src/main.tsx` 早期（React 渲染之前）通过 `initializeLanguage()`
 *   完成 locale 检测与切换；其他模块通过 `import i18n from '@/i18n/config'`
 *   或 barrel 文件 `@/i18n` 获取同一实例。
 *
 * 设计要点：
 *  - 默认语言（en）会同步加载，避免首屏闪烁；
 *  - 其他语言通过动态 `import()` 按需加载，避免进入主 bundle；
 *  - 调用 `i18n.changeLanguage(lng)` 前请先调用 `loadLanguageAsync(lng)`，
 *    以确保资源已就绪；
 *  - 通过 `i18n.d.ts` 的模块增强，使 `t()` 调用获得 key 类型校验。
 *
 * @see src/i18n/language-init.ts —— 启动期语言初始化流程
 * @see src/i18n/i18n.d.ts —— 类型增强声明
 */

import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from '../../locales/en.json'
import zh from '../../locales/zh.json'

/**
 * RTL（从右到左）语言代码列表。
 * 包含尚未加入 resources 的语言，便于未来扩展时无需修改此数组。
 * 在 `languageChanged` 事件中据此切换 document.documentElement.dir。
 */
const rtlLanguages = ['ar', 'he', 'fa', 'ur']

/**
 * 所有支持语言的静态列表（不依赖已加载的 resources）。
 * 新增 locale 文件时请同步更新此数组与 `resources` 块。
 */
const supportedLanguages = ['en', 'zh'] as const

// 初始化 i18next 并接入 react-i18next。
// 通过 init 一次性配置资源、默认语言、fallback 策略等。
i18n.use(initReactI18next).init({
  // 仅默认语言同步打入 bundle；其他语言以懒加载方式注入。
  resources: {
    en: { translation: en },
    zh: { translation: zh },
  },
  // 初始语言设为中文（与原型对齐），随后由 initializeLanguage 按偏好覆盖
  lng: 'zh',
  // fallback 语言：当当前语言缺失某 key 时回退到 en
  fallbackLng: 'en',

  // 允许部分加载的语言 —— 对于缺失的 key，i18next 会用 fallback 语言
  // 顶替，直到懒加载的 bundle 到位。
  partialBundledLanguages: true,

  interpolation: {
    escapeValue: false, // React 已自行转义，无需 i18next 二次转义
  },
})

// 语言切换事件：同步更新 <html> 的 dir 与 lang 属性。
// dir 影响 CSS 的文本方向（LTR/RTL），lang 影响屏幕阅读器与浏览器拼写检查。
i18n.on('languageChanged', lng => {
  const dir = rtlLanguages.includes(lng) ? 'rtl' : 'ltr'
  document.documentElement.dir = dir
  document.documentElement.lang = lng
})

/**
 * 已初始化的 i18next 实例（默认导出）。
 * 在 React 组件中应使用 useTranslation hook（基于 React Context），
 * 在非 React 上下文（如菜单构建、Tauri 命令处理）中可直接 import 此实例。
 */
export default i18n

// 命名导出 i18n，便于在非 React 上下文中按需 import（例如构建菜单）。
// 与 default export 引用同一实例，仅为使用习惯提供两种语法选择。
export { i18n }

/**
 * 若语言包尚未加载，则懒加载之。
 *
 * 使用 Vite 的动态 `import()`，将非默认语言切分为独立 chunk，
 * 仅在需要时才下载。
 *
 * @returns 一个 Promise，在语言包就绪后 resolve。
 */
export async function loadLanguageAsync(lng: string): Promise<void> {
  if (i18n.hasResourceBundle(lng, 'translation')) return
  if (!supportedLanguages.includes(lng as (typeof supportedLanguages)[number]))
    return

  try {
    const mod = await import(`../../locales/${lng}.json`)
    i18n.addResourceBundle(lng, 'translation', mod.default, true, true)
  } catch (error) {
    console.warn(`[i18n] Failed to lazy-load language "${lng}"`, error)
  }
}

/**
 * 获取可用语言列表的辅助函数。
 *
 * 类型标注为 `string[]`，调用方可以安全地使用 `.includes(someString)`，
 * 避免 TypeScript 类型收窄导致的报错（`readonly ['en', 'zh']` 不支持
 * `.includes('ja')` 之类的字符串入参）。
 *
 * @returns 支持语言的代码列表（如 `['en', 'zh']`）
 */
export const availableLanguages: string[] = [...supportedLanguages]

/**
 * 判断某语言是否为 RTL（从右到左）书写方向。
 *
 * 用于在切换语言时决定 `<html dir>` 属性，影响布局方向。
 *
 * @param lng — 语言代码（如 `'ar'`、`'zh'`）
 * @returns true 表示该语言为 RTL
 *
 * @example
 * if (isRTL(currentLanguage)) {
 *   document.documentElement.dir = 'rtl'
 * }
 */
export const isRTL = (lng: string): boolean => rtlLanguages.includes(lng)
