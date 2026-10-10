import type { AppLanguage } from '@/stores/persistent/settings-store';

/** AppLanguage → 该语言的自称（语言选择器显示用） */
export const LANGUAGE_ENDONYMS: Readonly<Record<AppLanguage, string>> = {
  'zh-CN': '简体中文',
  en: 'English',
};
