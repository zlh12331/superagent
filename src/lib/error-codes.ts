/**
 * 与 Rust 侧 `AppError::error_code()` 对齐的稳定错误码。
 *
 * 这些错误码必须与 `src-tauri/src/error.rs` 保持同步。
 * 前端通过这些错误码判断错误类型，而无需解析可读性较强的
 * 人类语言消息。
 *
 * @see src-tauri/src/error.rs — `AppError::error_code()`
 */
/**
 * 错误码常量集合（值对象）。
 *
 * 字段命名规则：`ERR_<域>[_<子类>]`，使用大写下划线以与 Rust 侧风格一致。
 * 字段值即为字符串字面量类型，便于 TypeScript 通过 `as const` 推导联合类型。
 *
 * 维护要点：新增错误码时，必须同步更新 Rust 侧 `AppError::error_code()`
 *   并补充对应单测，避免前后端可观测性指标漂移。
 */
export const ErrorCode = {
  IO: 'ERR_IO',
  SERIALIZATION: 'ERR_SERIALIZATION',
  PATH: 'ERR_PATH',
  VALIDATION: 'ERR_VALIDATION',
  NOT_FOUND: 'ERR_NOT_FOUND',
  TASK_JOIN: 'ERR_TASK_JOIN',
  TRAY: 'ERR_TRAY',
  QUICK_PANE: 'ERR_QUICK_PANE',
  NOTIFICATION: 'ERR_NOTIFICATION',
  WINDOW: 'ERR_WINDOW',
  RUNTIME_START: 'ERR_RUNTIME_START',
  RUNTIME_SHUTDOWN: 'ERR_RUNTIME_SHUTDOWN',
  NOT_INITIALIZED: 'ERR_NOT_INITIALIZED',
  APP_SERVER_ERROR: 'ERR_APP_SERVER',
} as const

/**
 * 错误码字面量联合类型，由 `ErrorCode` 常量对象自动推导。
 * 业务代码应优先使用此类型注解变量，避免硬编码字符串。
 */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * 用于运行时校验的全部合法错误码值。
 *
 * 通过 `Object.values` 在模块加载时一次性构造，避免每次校验都遍历对象。
 * 用于 `isErrorCode` 类型守卫以及与外部字符串集合做交集校验。
 */
export const ERROR_CODES: readonly string[] = Object.values(ErrorCode)

/**
 * 类型守卫：判断字符串是否为合法的错误码。
 *
 * 使用方式：在解析来自后端的字符串错误码时调用，可在编译期收窄类型，
 *   避免下游代码处理不存在的错误码分支。
 *
 * @param value 待校验的字符串
 * @returns true 表示 value 是已注册的 ErrorCode 字面量
 */
export function isErrorCode(value: string): value is ErrorCode {
  return ERROR_CODES.includes(value)
}
