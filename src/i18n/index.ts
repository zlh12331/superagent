/**
 * @file i18n 模块入口（barrel 文件）。
 *
 * 职责：集中导出 i18n 实例、配置函数与语言初始化工具，
 *   供其他模块通过 `@/i18n` 统一引用，避免直接依赖子模块路径。
 *
 * 导出项：
 *  - default / i18n —— 已初始化的 i18next 实例
 *  - availableLanguages / isRTL / loadLanguageAsync —— 语言查询与加载工具
 *  - initializeLanguage —— 启动期语言初始化入口
 *
 * @see src/i18n/config.ts —— 配置实现
 * @see src/i18n/language-init.ts —— 初始化流程
 */
export {
  default,
  i18n,
  availableLanguages,
  isRTL,
  loadLanguageAsync,
} from './config'
export { initializeLanguage } from './language-init'
