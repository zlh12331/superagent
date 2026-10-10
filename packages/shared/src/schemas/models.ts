import { z } from 'zod';

import { ApiKeyProviderSchema, ModelApiFormatSchema } from './settings';

/** re-export：API 协议格式（定义在 settings.ts——models 依赖 settings 的方向不变） */
export type { ModelApiFormat } from './settings';
export { MODEL_API_FORMATS, ModelApiFormatSchema } from './settings';

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
  modelId: z.string().min(1).max(100).optional(),
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
  apiFormat: ModelApiFormatSchema.optional(),
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
