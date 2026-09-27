// src/main/infra/i18n/index.ts
// 主进程轻量 i18n（零依赖 key-value 词典 + 运行时语言态）
// ──────────────────────────────────────────────────────────────
// 为什么不引入 i18next：主进程侧消费方目前仅工具 title（每次工具调用构造），
// 轻量 lookup 足够；渲染层继续走 i18next（check-i18n 门禁覆盖）。
//
// 语言真源与通知机制（沿用现有 settings 流的成熟接法，theme 同款模式）：
// - 真源：SQLite app_settings 表 `language` 域（渲染层 settings-store 写穿透）
// - 启动：main/index.ts 在 initDb() 之后调用 initMainI18n(readSetting('language'))
//   ——i18n 模块自身不 import settings-pref（避免把 electron/db 依赖拖进纯模块，
//   工具单测因此无需 mock 存储）；语言值由调用方读出后注入
// - 变更：settings.handler `set` 在 key === 'language' 时调 setMainLanguage(value)
//   （对照同文件 theme → syncTitleBarOverlayFromTheme 的既有先例）
// - t() 在调用时读当前语言态：工具 title 每次构造时求值，切换语言后下一回合
//   自然生效，无需失效通知
//
// 缺 key 行为：当前语言缺 → 回退 zh-CN → 仍缺返回 key 本身（fail-visible，
// 与渲染层 fallbackLng 语义一致）。
// ──────────────────────────────────────────────────────────────

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
