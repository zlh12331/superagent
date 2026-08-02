// packages/shared/src/schemas/settings.ts
// Settings 域 zod schema 单一真源（用户设置 / 敏感数据管理）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 集中定义 Settings 域 zod schema，作为 IPC 入参运行时校验的单一真源
// - 当前仅提供 API Key 管理（getSecret / setSecret / deleteSecret）
//   敏感数据通过主进程 safeStorage 加密存储，渲染层只读写明文
//
// 设计：
// - provider 字段标识 API 提供商（如 'deepseek'），作为 keychain 的 key
// - apiKey 明文由渲染层传入，主进程加密后存储
// - getApiKeyRes 返回 string | null（未设置时为 null，不返回 undefined 避免 IPC 序列化问题）
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

/**
 * API Key 提供商标识
 *
 * 用作 keychain 的 key 前缀（如 'deepseek' → 'deepseek-api-key'）。
 * 与主进程 ProviderRegistry（src/main/infra/ai/providers）保持一致：
 * - deepseek：DeepSeek 官方 API（OpenAI Compatible）
 * - openai：OpenAI 官方 API
 * - anthropic：Anthropic Claude API
 * - ollama：本地 Ollama 服务（无需 API Key，保留枚举项供 UI 展示）
 */
export const ApiKeyProviderSchema = z.enum(['deepseek', 'openai', 'anthropic', 'ollama']);

/** API Key 提供商标识 TypeScript 类型 */
export type ApiKeyProvider = z.infer<typeof ApiKeyProviderSchema>;

/**
 * settings:getApiKey 请求 payload
 *
 * 渲染层查询指定提供商的 API Key，主进程从 keychain 读取并解密返回。
 */
export const GetApiKeyReqSchema = z.object({
  /** API 提供商标识（如 'deepseek'） */
  provider: ApiKeyProviderSchema,
});

/**
 * settings:getApiKey 响应 payload
 *
 * apiKey 为 null 表示未设置，非 null 表示已设置（返回明文）。
 */
export interface GetApiKeyRes {
  /** API Key 明文（未设置时为 null） */
  readonly apiKey: string | null;
}

/**
 * settings:setApiKey 请求 payload
 *
 * 渲染层传入明文 API Key，主进程加密后存储到 keychain。
 */
export const SetApiKeyReqSchema = z.object({
  /** API 提供商标识 */
  provider: ApiKeyProviderSchema,
  /** API Key 明文（主进程加密后存储） */
  apiKey: z.string().min(1),
});

/** settings:setApiKey 响应 payload */
export interface SetApiKeyRes {
  /** 是否成功写入 */
  readonly ok: boolean;
}

/**
 * settings:deleteApiKey 请求 payload
 *
 * 删除指定提供商的 API Key。
 */
export const DeleteApiKeyReqSchema = z.object({
  provider: ApiKeyProviderSchema,
});

/** settings:deleteApiKey 响应 payload */
export interface DeleteApiKeyRes {
  /** 是否成功删除（未设置时也返回 true） */
  readonly ok: boolean;
}

// ─── Telemetry 用户开关（隐私合规） ─────────────────────────────

/**
 * 遥测级别（对标 VS Code telemetry.telemetryLevel / Cursor 双开关）
 *
 * - off：完全不初始化 Sentry，不上报任何错误和性能数据
 * - error-only：仅上报错误（tracesSampleRate = 0），不上报性能事务
 * - full：上报错误 + 性能事务（受 tracesSampleRate 采样率控制）
 */
export const TelemetryLevelSchema = z.enum(['off', 'error-only', 'full']);

/** 遥测级别 TypeScript 类型 */
export type TelemetryLevel = z.infer<typeof TelemetryLevelSchema>;

/**
 * settings:getTelemetryLevel 响应 payload
 */
export interface GetTelemetryLevelRes {
  /** 当前遥测级别 */
  readonly level: TelemetryLevel;
}

/**
 * settings:setTelemetryLevel 请求 payload
 */
export const SetTelemetryLevelReqSchema = z.object({
  /** 目标遥测级别 */
  level: TelemetryLevelSchema,
});

/** settings:setTelemetryLevel 响应 payload */
export interface SetTelemetryLevelRes {
  /** 是否成功写入 */
  readonly ok: boolean;
  /** 写入后的级别（用于 UI 回显确认） */
  readonly level: TelemetryLevel;
}
