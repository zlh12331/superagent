export type { SupportedLanguage } from './config';

export {
  changeLanguage,
  DEFAULT_LANGUAGE,
  i18n,
  initI18n,
  LANGUAGE_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
} from './config';
export { I18nProvider } from './I18nProvider';

export { useErrorMessage, useTranslation } from './use-translation';
