// packages/shared/src/schemas/models.ts
// 模型清单契约（models:list）
// ──────────────────────────────────────────────────────────────
// 背景：渲染层模型选择器此前硬编码内置模型表（MODEL_CONFIGS），
// 与主进程 modelRegistry 真实注册表不一致（双源漂移）。
// 本契约暴露主进程真实清单（内置 + 运行时合并），渲染层零硬编码——
// 后端没有就是没有。
// ──────────────────────────────────────────────────────────────

import { z } from 'zod';

import { ApiKeyProviderSchema } from './settings';

/** 可用模型信息（对齐主进程 ModelRegistry.listModels 形状） */
export interface AvailableModelInfo {
  /** 模型 id（全局唯一） */
  readonly id: string;
  /** 展示名（内置模型为 displayName，运行时模型为 modelId） */
  readonly label: string;
  /** 所属供应商（deepseek / openai / anthropic / ollama） */
  readonly providerKind: z.infer<typeof ApiKeyProviderSchema>;
  /** 是否运行时注册（区别于内置模型） */
  readonly isRuntime: boolean;
  /** 能力元数据（vision / contextWindowSize / fastOnly / reasoning 等） */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** models:list 响应 */
export interface ModelsListRes {
  readonly models: readonly AvailableModelInfo[];
}

/** models:list 响应 zod schema（响应契约校验用） */
export const ModelsListResSchema = z.object({
  models: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      providerKind: ApiKeyProviderSchema,
      isRuntime: z.boolean(),
      capabilities: z.record(z.string(), z.unknown()),
    }),
  ),
});

/**
 * models:listBuiltin 入参（配置页厂商下拉数据源）
 *
 * 与 list 的区别：不依赖 keychain 配置状态（配置页恰恰为未配置用户服务，
 * "配置好才显示"的过滤只适用于聊天框模型选择器）。
 */
export const ModelsListBuiltinReqSchema = z.object({
  /** 供应商（空串 = 全部厂商内置模型） */
  providerKind: ApiKeyProviderSchema.optional(),
});

/** models:listBuiltin 入参类型 */
export interface ModelsListBuiltinReq {
  readonly providerKind?: z.infer<typeof ApiKeyProviderSchema>;
}

/** models:listBuiltin 响应（复用 AvailableModelInfo 形状） */
export interface ModelsListBuiltinRes {
  readonly models: readonly AvailableModelInfo[];
}

/** models:listBuiltin 响应 zod schema */
export const ModelsListBuiltinResSchema = ModelsListResSchema;

/**
 * models:test 入参 zod schema（连通性测试）
 *
 * baseUrl/apiKey 省略时回退主进程默认端点与 keychain 已存 key。
 */
export const TestModelReqSchema = z.object({
  providerKind: ApiKeyProviderSchema,
  // 模型 id（可选；用于请求体 model 字段，省略用占位值）
  modelId: z.string().min(1).max(100).optional(),
  // 显式 baseUrl（可选；省略走主进程默认端点）
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  // 显式 API Key（可选；省略回退 keychain 提供商/运行时模型 key）
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
});

/** models:test 响应 payload */
export interface TestModelRes {
  /** 是否连通 */
  readonly ok: boolean;
  /** 失败原因（ok=false 时非空） */
  readonly error?: string;
}

/** models:test 响应 zod schema（R4：响应契约校验） */
export const TestModelResSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
