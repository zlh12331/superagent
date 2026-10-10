import { MAIN_DICTIONARIES, type MainLanguage } from './dictionaries';

export const DEFAULT_MAIN_LANGUAGE: MainLanguage = 'zh-CN';

let currentLanguage: MainLanguage = DEFAULT_MAIN_LANGUAGE;

export function asMainLanguage(value: unknown): MainLanguage {
  return value === 'en' ? 'en' : DEFAULT_MAIN_LANGUAGE;
}

export function initMainI18n(language: unknown): void {
  currentLanguage = asMainLanguage(language);
}

export function setMainLanguage(value: unknown): void {
  currentLanguage = asMainLanguage(value);
}

export function getMainLanguage(): MainLanguage {
  return currentLanguage;
}

function interpolate(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const dict = MAIN_DICTIONARIES[currentLanguage];
  const fallback = MAIN_DICTIONARIES[DEFAULT_MAIN_LANGUAGE];
  const template = dict[key] ?? fallback[key] ?? key;
  return params === undefined ? template : interpolate(template, params);
}
