/**
 * 使用 `@t3-oss/env-core` 进行类型安全的环境变量校验。
 *
 * 该模块会在构建期校验所有 `VITE_*` 环境变量。
 * 如果某个变量缺失或格式不正确，构建会立即失败并给出明确的
 * 错误信息 — 而非静默通过后在运行时引发难以排查的 bug。
 *
 * 用法：
 *   import { env } from '@/lib/env'
 *   const dsn = env.VITE_SENTRY_DSN // 字符串（可能为空字符串）
 */

import { createEnv } from '@t3-oss/env-core'
import { z } from 'zod'

export const env = createEnv({
  /**
   * 服务端环境变量（在纯客户端 Vite 应用中未使用，
   * 但为 API 契约所必需）。
   */
  server: {},

  /**
   * 客户端环境变量 — 以 `VITE_` 为前缀。
   *
   * `VITE_SENTRY_DSN` 为可选（空字符串表示禁用 Sentry）。
   * 若提供该变量，则必须是合法的 URL。
   */
  client: {
    VITE_SENTRY_DSN: z
      .string()
      .url('VITE_SENTRY_DSN must be a valid URL or empty')
      .or(z.literal(''))
      .default(''),
  },

  /**
   * 告知 `@t3-oss/env-core`，`VITE_SENTRY_DSN` 来自
   * `import.meta.env`。
   */
  clientPrefix: 'VITE_',

  /**
   * 运行时环境访问 — Vite 通过 `import.meta.env` 暴露环境变量。
   */
  runtimeEnv: import.meta.env,
})

/**
 * 检测当前运行环境是否为 Tauri 桌面应用（非纯浏览器）。
 *
 * 判断依据：Tauri 框架在运行时会向全局 `window` 对象注入
 * `__TAURI_INTERNALS__` 属性。该属性仅在 Tauri WebView 中存在，
 * 普通浏览器环境（如开发时的 `vite dev`）不会注入。
 *
 * 使用场景：
 * - 在浏览器开发模式下返回 Mock 数据，便于前端独立调试
 * - 在 Tauri 环境下调用真实的后端命令（Rust 侧）
 *
 * @returns true 表示运行在 Tauri 桌面应用中；false 表示运行在纯浏览器
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
