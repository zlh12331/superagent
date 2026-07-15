/**
 * @file i18next 类型增强声明。
 *
 * 职责：通过 TypeScript 的 `declare module` 模块增强（module augmentation）机制，
 *   将 `locales/en.json` 的结构注入到 react-i18next 的 `CustomTypeOptions` 中，
 *   使所有 `t('some.key')` 调用获得：
 *   1. key 的字面量类型校验（拼错 key 在编译期报错）；
 *   2. 返回值类型推断（嵌套对象、插值参数等）；
 *   3. 自动补全（IDE 提示可选的 key）。
 *
 * 设计要点：
 *  - 以 `en.json` 作为类型来源（fallback 语言），所有 locale 必须保持 key 一致；
 *  - `defaultNS: 'translation'` 与 `config.ts` 中的 `resources.translation` 对应；
 *  - 文件后缀 `.d.ts` 表示纯类型声明，编译后不产生运行时代码。
 *
 * @see src/i18n/config.ts —— 实际初始化逻辑
 * @see ../../locales/en.json —— 类型推断的源数据
 */

import 'react-i18next'
import type en from '../../locales/en.json'

declare module 'react-i18next' {
  /**
   * 自定义 i18next 类型选项。
   * 此 interface 通过模块增强合并到 react-i18next 的内置类型中。
   */
  interface CustomTypeOptions {
    /** 默认命名空间，与 `config.ts` 中 `resources.translation` 对齐 */
    defaultNS: 'translation'
    /** 资源结构 —— 由 `en.json` 推断，保证类型与 fallback 资源一致 */
    resources: {
      translation: typeof en
    }
  }
}
