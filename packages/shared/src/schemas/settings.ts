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
 * 当前仅支持 deepseek，后续可扩展 openai / anthropic 等。
 */
export const ApiKeyProviderSchema = z.enum(['deepseek']);

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
