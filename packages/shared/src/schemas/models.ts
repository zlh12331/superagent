// models.ts：模型清单域 IPC 契约单一真源——models:list / listBuiltin / test 的入参与响应形状
// 消费方：IPC 定义表（packages/shared/src/ipc/definitions.ts）的 models 域——注册层（src/main/ipc/register.ts）
// 据此校验入参并校验 handler 返回值（响应契约缺失即启动抛错）。模型清单的数据源只有主进程一处（渲染层经
// src/renderer/hooks/use-models.ts 取数），避免选择器与真实注册表双源漂移。
// 边界：只定义形状（清单数据源与连通性探测在 src/main/ipc/models.handler.ts）；响应 interface 与 zod schema
// 成对手写、无 z.infer 派生，增删字段须两处同步。

import { z } from 'zod';

import { ApiKeyProviderSchema, ModelApiFormatSchema } from './settings';

/** re-export：API 协议格式（定义在 settings.ts——models 依赖 settings 的方向不变） */
export type { ModelApiFormat } from './settings';
export { MODEL_API_FORMATS, ModelApiFormatSchema } from './settings';

// ────────── models:list：对话区模型选择器的清单数据源（src/renderer/components/common/ModelSelector.tsx）──────────

/**
 * 可用模型信息（IPC 传输形状，对齐主进程 ModelRegistry.listModels 的元素）
 *
 * capabilities 刻意用 Record<string, unknown> 而非具体能力接口：IPC 边界不钉能力字段，
 * 具体能力集（ModelCapabilities）属主进程内部形状，见 src/main/infra/ai/models/types.ts。
 */
export interface AvailableModelInfo {
  /** 模型 id（全局唯一） */
  readonly id: string;
  /** 展示名（主进程按各自数据源解析，缺省回退模型 id；渲染层直接展示，勿自行拼接） */
  readonly label: string;
  /** 所属供应商（选择器按它分组；值域见 settings.ts 的 ApiKeyProviderSchema） */
  readonly providerKind: z.infer<typeof ApiKeyProviderSchema>;
  /** 是否来自运行时注册表（用户配置的模型）；false = 内置模型 */
  readonly isRuntime: boolean;
  /** 能力元数据（vision / contextWindowSize / fastOnly / reasoning 等）；主进程对不上内置条目时为空对象 */
  readonly capabilities: Readonly<Record<string, unknown>>;
}

/** models:list 响应（只含已启用的已配置模型；空数组 = 尚未配置，选择器显示未配置态） */
export interface ModelsListRes {
  readonly models: readonly AvailableModelInfo[];
}

/** models:list 响应 zod schema（定义表引用：注册层据此校验 handler 返回值，防手写 Res 接口漂移） */
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

// ────────── models:listBuiltin：设置页模型配置弹窗的厂商下拉数据源（src/renderer/components/settings/sections/dialogs/model-config-dialog.tsx）──────────

/**
 * models:listBuiltin 入参（厂商下拉数据源）
 *
 * 与 list 的区别：不做 keychain 配置过滤（配置页恰恰为未配置用户服务，
 * "配置好才显示"的过滤只适用于聊天框模型选择器；照搬会让配置页拿不到候选）。
 */
export const ModelsListBuiltinReqSchema = z.object({
  /** 厂商过滤；省略 = 全部厂商（枚举不含空串，传 '' 会被入参校验拒绝） */
  providerKind: ApiKeyProviderSchema.optional(),
});

/** models:listBuiltin 入参类型 */
export interface ModelsListBuiltinReq {
  /** 厂商过滤；省略 = 全部厂商 */
  readonly providerKind?: z.infer<typeof ApiKeyProviderSchema>;
}

/** models:listBuiltin 响应（复用 AvailableModelInfo 形状；内置模型 isRuntime 恒为 false） */
export interface ModelsListBuiltinRes {
  readonly models: readonly AvailableModelInfo[];
}

/**
 * models:listBuiltin 响应 zod schema
 *
 * 与 models:list 响应同形（元素同样是 AvailableModelInfo），直接复用同一 schema 对象——
 * 形状演进只需改 ModelsListResSchema 一处。
 */
export const ModelsListBuiltinResSchema = ModelsListResSchema;

// ────────── models:test：保存/编辑弹窗的连通性探测（最小 POST 探针，只读不落库）──────────

/**
 * models:test 入参 zod schema（连通性测试）
 *
 * baseUrl/apiKey 省略时回退主进程默认端点与 keychain 已存 key。
 */
export const TestModelReqSchema = z.object({
  providerKind: ApiKeyProviderSchema,
  /** 探测请求体的模型 id（省略时主进程用占位值拼请求体） */
  modelId: z.string().min(1).max(100).optional(),
  /** 显式 baseUrl（省略走主进程默认端点） */
  baseUrl: z
    .string()
    .url()
    .optional()
    .transform((v) => v ?? undefined),
  /** 显式 API Key（省略回退 keychain：先厂商级 key，再运行时模型 key） */
  apiKey: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v ?? undefined),
  /**
   * API 协议格式（省略 = 主进程按 providerKind 默认；模型已落库时回退其保存值）
   *
   * 仅自定义模式由渲染层显式下发——保存前测试时模型尚未落库，不随请求传入就测不到用户刚选的格式；
   * 服务商模式的格式由 providerKind 决定，无需下发。
   */
  apiFormat: ModelApiFormatSchema.optional(),
});

/** models:test 响应 payload */
export interface TestModelRes {
  /** 是否连通 */
  readonly ok: boolean;
  /** 失败原因（ok=false 时非空：密钥无效 / HTTP 状态码 / 网络异常） */
  readonly error?: string;
}

/** models:test 响应 zod schema（定义表引用：注册层据此校验 handler 返回值，防手写 Res 接口漂移） */
export const TestModelResSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});
