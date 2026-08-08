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
