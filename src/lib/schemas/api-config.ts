/**
 * @file API 配置表单的 Zod schema。
 *
 * 职责：定义 endpoint/apiKey/timeout/retry/debugMode 等字段的校验规则，
 *   并提供 schema-first 的类型推断与默认值。
 *
 * 使用方式：
 *  - 在 React Hook Form 中通过 `zodResolver(apiConfigSchema)` 接入表单校验；
 *  - 通过 `createApiConfigSchema(messages)` 工厂函数注入 i18n 错误文案，
 *    避免硬编码字符串。
 *
 * @see components/preferences/panes/ApiConfigForm.tsx 表单实现
 */

import { z } from 'zod'

/**
 * API 配置 schema 的错误信息集合。
 * 通过 `createApiConfigSchema()` 传入本地化字符串以支持 i18n。
 */
export interface ApiConfigMessages {
  endpointInvalid: string
  apiKeyMin: string
  timeoutMin: string
  timeoutMax: string
  retryMin: string
  retryMax: string
}

/**
 * 默认英文错误信息。
 *
 * 用于在 i18n 翻译未就绪时（如模块加载早期）的兜底显示。
 */
export const defaultApiConfigMessages: ApiConfigMessages = {
  endpointInvalid: 'Must be a valid URL',
  apiKeyMin: 'API key must be at least 10 characters',
  timeoutMin: 'Timeout must be at least 1 second',
  timeoutMax: 'Timeout must not exceed 300 seconds',
  retryMin: 'Retry count must be at least 0',
  retryMax: 'Retry count must not exceed 10',
}

/**
 * API 配置表单的 schema 工厂函数。
 *
 * 遵循 schema-first 方法：zod schema 是校验规则的唯一真实来源，
 * TypeScript 类型从 schema 推断而来。
 *
 * @param messages - 本地化的错误信息
 * @returns 构造好的 ZodObject，可直接传入 zodResolver 或用于独立校验
 */
export function createApiConfigSchema(messages: ApiConfigMessages) {
  return z.object({
    endpoint: z.string().url(messages.endpointInvalid),
    apiKey: z.string().min(10, messages.apiKeyMin),
    timeoutSeconds: z
      .number()
      .min(1, messages.timeoutMin)
      .max(300, messages.timeoutMax),
    retryCount: z.number().min(0, messages.retryMin).max(10, messages.retryMax),
    debugMode: z.boolean(),
  })
}

/** 使用英文信息的默认 schema 实例 */
export const apiConfigSchema = createApiConfigSchema(defaultApiConfigMessages)

/** 从 schema 推断的表单值类型（schema-first） */
export type ApiConfigFormValues = z.infer<typeof apiConfigSchema>

/**
 * 初始渲染时使用的默认表单值。
 *
 * 选择 timeout=30s/retry=3 作为合理的默认配置，避免新用户面对空表单。
 */
export const apiConfigDefaults: ApiConfigFormValues = {
  endpoint: '',
  apiKey: '',
  timeoutSeconds: 30,
  retryCount: 3,
  debugMode: false,
}
