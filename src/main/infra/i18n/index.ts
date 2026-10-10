// i18n/index.ts：主进程侧最小翻译层——托盘等主进程 UI 的双语词典查找 + {param} 插值
// 边界：渲染层走 i18next 完整管线，两边不共用实现；语言真源在 settings.language
import { MAIN_DICTIONARIES, type MainLanguage } from './dictionaries';

export const DEFAULT_MAIN_LANGUAGE: MainLanguage = 'zh-CN';

let currentLanguage: MainLanguage = DEFAULT_MAIN_LANGUAGE;

/** 未知/损坏的语言值一律回落中文（主进程文案只有双语，不存在第三态） */
export function asMainLanguage(value: unknown): MainLanguage {
  return value === 'en' ? 'en' : DEFAULT_MAIN_LANGUAGE;
}

/** 启动序列调用：按 settings.language 初始化 */
export function initMainI18n(language: unknown): void {
  currentLanguage = asMainLanguage(language);
}

/** 运行中切语言（settings:set 的 language 分支调用） */
export function setMainLanguage(value: unknown): void {
  currentLanguage = asMainLanguage(value);
}

/** 当前语言（托盘菜单构建时读取） */
export function getMainLanguage(): MainLanguage {
  return currentLanguage;
}

// {name} 占位插值：参数缺失保留原占位符（便于发现词典/调用两侧不匹配）
function interpolate(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** 翻译：当前语言 → 默认语言 → key 本身三级回落（缺词条不炸，宁可露 key） */
export function t(key: string, params?: Readonly<Record<string, string | number>>): string {
  const dict = MAIN_DICTIONARIES[currentLanguage];
  const fallback = MAIN_DICTIONARIES[DEFAULT_MAIN_LANGUAGE];
  const template = dict[key] ?? fallback[key] ?? key;
  return params === undefined ? template : interpolate(template, params);
}
