import type { ReactElement, ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';

import { i18n, initI18n } from './config';

initI18n();

/**
 * i18n Provider
 *
 * 包装 I18nextProvider，把已初始化的 i18n 实例注入 React 上下文
 */
export function I18nProvider({ children }: { children: ReactNode }): ReactElement {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}
