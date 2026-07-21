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

import { type ReactElement, type ReactNode, useEffect } from 'react';
import { I18nextProvider } from 'react-i18next';

import { i18n, initI18n } from './config';

/**
 * i18n Provider
 *
 * 包装 I18nextProvider，在挂载时完成 i18n 初始化
 */
export function I18nProvider({ children }: { children: ReactNode }): ReactElement {
  // 在应用启动时初始化 i18next（同步完成，资源已内联）
  useEffect(() => {
    initI18n();
  }, []);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
