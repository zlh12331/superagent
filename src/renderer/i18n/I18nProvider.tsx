// src/renderer/i18n/I18nProvider.tsx
// i18next React Provider
// ──────────────────────────────────────────────────────────────
// 职责：
// - 在应用启动时调用 initI18n() 完成初始化
// - 通过 I18nextProvider 把 i18n 实例注入 React 上下文
//   （虽然 react-i18next 默认用全局 instance，但显式 Provider 更规范）
//
// 嵌套关系：
// - 必须在 ThemeProvider 外（theme 可能依赖文案）
// - 必须在 QueryProvider 外（Query 错误提示依赖文案）
//
// 使用方式：
//   <I18nProvider>
//     <App />
//   </I18nProvider>
//
// 子组件消费：
//   import { useTranslation } from 'react-i18next';
//   const { t } = useTranslation();
//   t('common.save')  // → "保存" 或 "Save"
//   t('errors.AI_TIMEOUT', { ns: 'errors' })  // → "AI 调用超时"
// ──────────────────────────────────────────────────────────────

import type { ReactElement, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { i18n, initI18n } from './config';

// 模块加载时同步初始化 i18next（资源已内联，init() 同步完成）
// 必须在 I18nextProvider 渲染前完成，否则子组件首次 useTranslation 时
// i18n 实例尚未 init，触发 Suspense loading 导致白屏
initI18n();

/**
 * i18n Provider
 *
 * 包装 I18nextProvider，把已初始化的 i18n 实例注入 React 上下文
 */
export function I18nProvider({ children }: { children: ReactNode }): ReactElement {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
