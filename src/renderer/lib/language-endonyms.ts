// src/renderer/lib/language-endonyms.ts
// 语言端名（endonym）常量：语言选择器固定以「该语言的自称」显示
// ──────────────────────────────────────────────────────────────
// i18n 例外的设计落点：语言名不随 UI 语言切换（中文界面里英文项仍叫
// English，英文界面里中文项仍叫 简体中文），因此不是 UI 文案、不走 t()。
// 放在 .ts 数据模块（非 .tsx）——check-i18n 的硬编码中文扫描只覆盖 tsx
// 的 JSX 文本/属性/表达式，语言不变数据在此域外，属有意豁免而非漏扫。
// ──────────────────────────────────────────────────────────────

import type { AppLanguage } from '@/stores/persistent/settings-store';

/** AppLanguage → 该语言的自称（语言选择器显示用） */
export const LANGUAGE_ENDONYMS: Readonly<Record<AppLanguage, string>> = {
  'zh-CN': '简体中文',
  en: 'English',
};
