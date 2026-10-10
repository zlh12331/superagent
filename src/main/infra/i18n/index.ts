import { MAIN_DICTIONARIES, type MainLanguage } from './dictionaries';

/** 默认语言（与渲染层 DEFAULT_LANGUAGE 一致） */
export const DEFAULT_MAIN_LANGUAGE: MainLanguage = 'zh-CN';

let currentLanguage: MainLanguage = DEFAULT_MAIN_LANGUAGE;

/** 语言值收窄：白名单外（含非法类型）一律回退默认 */
export function asMainLanguage(value: unknown): MainLanguage {
  return value === 'en' ? 'en' : DEFAULT_MAIN_LANGUAGE;
}

/**
 * 初始化主进程语言（应用启动期一次；重复调用以最后一次为准）
 *
 * @param language app_settings `language` 域原始值（未设置/损坏传 undefined）
 */
export function initMainI18n(language: unknown): void {
  currentLanguage = asMainLanguage(language);
}

/** 语言变更（settings.handler set 钩子调用；幂等） */
export function setMainLanguage(value: unknown): void {
  currentLanguage = asMainLanguage(value);
}

/** 当前主进程语言（测试与诊断用） */
export function getMainLanguage(): MainLanguage {
  return currentLanguage;
}

/** 插值：{name} 占位；缺参保留占位原文（fail-visible） */
function interpolate(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * 主进程文案查询（轻量 t()）
 *
 * @param key 词典 key（缺失时返回 key 本身）
 * @param params 插值参数（{name} 占位）
 */
export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const dict = MAIN_DICTIONARIES[currentLanguage];
  const fallback = MAIN_DICTIONARIES[DEFAULT_MAIN_LANGUAGE];
  const template = dict[key] ?? fallback[key] ?? key;
  return params === undefined ? template : interpolate(template, params);
}
