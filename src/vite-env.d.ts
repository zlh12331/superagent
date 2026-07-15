/// <reference types="vite/client" />

declare const __APP_VERSION__: string

/**
 * Vite 环境变量类型扩展
 *
 * 通过 VITE_ 前缀的环境变量在编译时注入，
 * 运行时通过 import.meta.env 访问。
 */
interface ImportMetaEnv {
  /** Mock 场景选择（normal/boundary/error），仅浏览器开发模式生效 */
  readonly VITE_MOCK_SCENARIO?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
