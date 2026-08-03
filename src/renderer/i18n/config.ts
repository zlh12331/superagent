// src/renderer/i18n/config.ts
// i18next 配置入口
// ──────────────────────────────────────────────────────────────
// 设计原则：
// - 资源文件按 namespace 拆分（errors / common / 后续业务 namespace）
// - 默认语言 zh-CN，fallback 也是 zh-CN（保证缺失 key 时显示中文而非 key 本身）
// - 语言检测：localStorage > navigator > 默认
// - 与 settings-store 协同：settings-store 不直接管理语言，
//   而是由 LanguageDetector 持久化到 localStorage（key: code-agent:lang）
//   这样 settings-store 不必引入 i18next 类型，保持职责单一
//
// 资源加载策略：
// - 当前采用「全量打包」模式（所有语言资源都进 bundle）
// - 适合 Electron 渲染层（无网络请求，本地资源）
// - 未来语言增多可改为按需 import() + Suspense 懒加载
//
// i18next API 参考：
// - use() 用于注册插件（initReactI18next / LanguageDetector）
// - init() 返回 Promise，但资源已通过 import 内联时同步可用
// - 全局 instance 共享，单次初始化
// ──────────────────────────────────────────────────────────────

import i18next from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import { initReactI18next } from 'react-i18next';

// 资源文件导入（Vite 支持 JSON 默认导入）
import enCommon from './locales/en/common.json';
import enErrors from './locales/en/errors.json';
import zhCNCommon from './locales/zh-CN/common.json';
import zhCNErrors from './locales/zh-CN/errors.json';

/** 支持的语言列表（用于语言切换 UI） */
export const SUPPORTED_LANGUAGES = ['zh-CN', 'en'] as const;

/** 支持的语言类型 */
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** 默认语言（也是 fallback 语言） */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'zh-CN';

/** localStorage key（与 settings-store 的前缀对齐） */
export const LANGUAGE_STORAGE_KEY = 'code-agent:lang';

/**
 * i18next 资源结构
 *
 * 结构：{ 语言: { namespace: { translation: {...} } } }
 * 资源 JSON 文件内部包了一层 "translation"，符合 i18next 默认命名空间约定
 */
export const resources = {
  'zh-CN': {
    common: zhCNCommon.translation,
    errors: zhCNErrors.translation,
  },
  en: {
    common: enCommon.translation,
    errors: enErrors.translation,
  },
} as const;

/** i18next 初始化配置 */
export const i18nOptions = {
  // 默认语言（也是 fallback）
  lng: DEFAULT_LANGUAGE,
  // 回退语言：当当前语言缺失某个 key 时，回退到 zh-CN
  fallbackLng: DEFAULT_LANGUAGE,
  // 资源
  resources,
  // 默认命名空间
  defaultNS: 'common',
  // 启用的命名空间
  ns: ['common', 'errors'],
  // 插值：避免 XSS（默认已开启，显式声明）
  interpolation: {
    escapeValue: false, // React 已自动转义，i18next 不需要再转义
  },
  // 语言检测
  detection: {
    order: ['localStorage', 'navigator'],
    lookupLocalStorage: LANGUAGE_STORAGE_KEY,
    cachesLocalStorage: ['localStorage'],
  },
  // React 集成
  react: {
    useSuspense: false, // Electron 渲染层不需要 Suspense（资源已打包）
  },
};

/** 初始化标志，防止重复 init */
let initialized = false;

/**
 * 初始化 i18next（同步可用，因为资源已内联）
 *
 * 在 I18nProvider 中调用一次，之后整个应用共享同一个 instance
 *
 * 使用链式 use() 注册插件：
 * - initReactI18next：让 React 组件能通过 useTranslation 响应语言变化
 * - LanguageDetector：自动从 localStorage / navigator 检测语言
 */
export function initI18n(): typeof i18next {
  if (initialized) {
    return i18next;
  }
  initialized = true;

  // use() 返回 i18next 实例，链式调用
  // init() 同步完成（资源已内联，无网络请求）
  void i18next.use(initReactI18next).use(LanguageDetector).init(i18nOptions);
  return i18next;
}

/** i18next 实例（供非 React 代码使用，如工具函数直接调用 t()） */
export const i18n = i18next;

/** 当前语言（供非 React 代码读取） */
export function getCurrentLanguage(): SupportedLanguage {
  const current = i18next.language ?? DEFAULT_LANGUAGE;
  return current as SupportedLanguage;
}

/**
 * 切换语言（同步操作，无需 await）
 *
 * 切换后 i18next 会自动写入 localStorage（由 detection.cachesLocalStorage 配置）
 * 同时触发所有 useTranslation 组件重渲染
 */
export function changeLanguage(lng: SupportedLanguage): void {
  void i18next.changeLanguage(lng);
}
