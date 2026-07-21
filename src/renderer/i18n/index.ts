// src/renderer/i18n/index.ts
// i18n 模块入口
// ──────────────────────────────────────────────────────────────
// 模块职责：
// - 提供 i18n 配置 / Provider / hook 的统一导出
// - 业务方从这里导入 I18nProvider、useTranslation、useErrorMessage
//
// 与 packages/shared 的关系：
// - shared 不依赖 i18next（保持跨进程纯类型/常量）
// - shared.ERROR_META.userMessage 仍保留中文默认值，作为：
//   1) 主进程日志/IPC 的兜底文案（主进程不引入 i18next，避免 Node 端开销）
//   2) i18n 资源缺失时的 fallback
// - 渲染层优先用 useErrorMessage(code) 查询本地化文案
// ──────────────────────────────────────────────────────────────

export type { SupportedLanguage } from './config';

// 配置（供测试或非 React 代码使用）
export {
  changeLanguage,
  DEFAULT_LANGUAGE,
  i18n,
  initI18n,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
} from './config';
// Provider
export { I18nProvider } from './I18nProvider';

// hook
export { useErrorMessage, useTranslation } from './use-translation';
