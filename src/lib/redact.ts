/**
 * 用于日志和 Sentry 事件的敏感数据脱敏。
 *
 * 与 Rust 侧的 `utils::redact::redact_sensitive()` 函数对应。
 * 将敏感 key（api_key、token、authorization 等）对应的值替换为
 * `***`，防止凭据通过日志文件或 Sentry 事件意外泄露。
 *
 * @see src-tauri/src/utils/redact.rs
 */

/**
 * 匹配字符串中 "敏感 key + 分隔符 + 值" 模式的正则。
 *
 * 捕获组 1：保留 key 与分隔符（如 `api_key=`），仅替换后面的值；
 * 大小写不敏感，并兼容 `access_token` / `access-token` / `accessToken` 等命名风格。
 */
const SENSITIVE_VALUE_PATTERN =
  /((?:access[_-]?token|refresh[_-]?token|api[_-]?token|api[_-]?key|authorization|password|secret|cookie|token)\s*[:=]\s*"?)[^\s",}\]]+/gi

/**
 * 敏感 key 名字面量集合。
 * 用于在对象遍历时精确匹配（而非子串匹配），避免误伤形如 `tokensCount` 的字段。
 */
const SENSITIVE_KEY_NAMES =
  /^(?:access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|password|secret|cookie|token)$/i

/**
 * 将字符串中的敏感值替换为 `***`。
 *
 * @example
 * ```ts
 * redactString('api_key=abc123') // 'api_key=***'
 * redactString('"token": "xyz"') // '"token": "***"'
 * ```
 */
export function redactString(input: string): string {
  return input.replace(SENSITIVE_VALUE_PATTERN, '$1***')
}

/**
 * 返回 `true` 表示该 key 名被视为敏感。
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_NAMES.test(key)
}

/**
 * 对对象中的敏感值进行深度脱敏。
 *
 * 对于 key 名匹配敏感模式的对象属性，
 * 整个值会被替换为 `'***'`。对象中的字符串值
 * 也会经过 `redactString` 处理。
 *
 * 处理规则：
 *  - 字符串：递归调用 redactString 做子串匹配；
 *  - 数组：逐元素递归；
 *  - 对象：按 key 决定整体替换或递归 value；
 *  - 其他原始类型（number/boolean/null）：原样返回。
 *
 * 类型设计：通过 `as unknown as T` 保持入参与返回值类型一致，
 *   避免调用方手动断言；运行时结构由本函数保证安全。
 *
 * @example
 * ```ts
 * redactObject({ api_key: 'abc', user: { token: 'xyz' } })
 * // { api_key: '***', user: { token: '***' } }
 * ```
 *
 * @param obj 任意可序列化结构
 * @returns 同结构脱敏后的副本（原始对象不被修改）
 */
export function redactObject<T>(obj: T): T {
  // 字符串：直接做正则替换
  if (typeof obj === 'string') {
    return redactString(obj) as unknown as T
  }
  // 数组：保留数组形态，逐元素递归
  if (Array.isArray(obj)) {
    return obj.map(redactObject) as unknown as T
  }
  // 对象：构造新对象以避免修改入参，按 key 是否敏感决定整体替换或递归
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      if (isSensitiveKey(key)) {
        // 命中敏感 key：整体替换，不再递归 value
        result[key] = '***'
      } else {
        result[key] = redactObject(value)
      }
    }
    return result as unknown as T
  }
  // number/boolean/null/undefined 等原始类型：无敏感信息
  return obj
}
