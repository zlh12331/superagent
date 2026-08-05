// src/main/infra/ai/models/index.ts
// 模型领域层统一入口
// ──────────────────────────────────────────────────────────────
// 职责：
// - 导出模型领域类型（ModelEntry / ModelCapabilities / ResolvedModel 等）
// - 导出 ModelRegistry 类与内置模型定义表
// - 导出模块级单例 modelRegistry（默认配置：内置模型 + DEFAULT_KIND 为默认供应商）
//
// 依赖方向：本层不依赖 providers 层实例（默认模型/默认供应商的单一真源在
// builtin-models.ts，providers 反向从本层派生），避免领域层依赖倒挂。
// ──────────────────────────────────────────────────────────────

import { BUILTIN_MODELS, DEFAULT_KIND, DEFAULT_MODEL_BY_KIND } from './builtin-models';
import { ModelRegistry } from './registry';
import type {
  AvailableModelInfo,
  ModelCapabilities,
  ModelEntry,
  ModelGenerationConfig,
  ReasoningEffort,
  ResolvedModel,
  RuntimeModelSnapshot,
} from './types';

export { BUILTIN_MODELS, DEFAULT_KIND, DEFAULT_MODEL_BY_KIND } from './builtin-models';
export type { GenerationOptions } from './generation-options';
export { buildGenerationOptions } from './generation-options';
export {
  clampDeepSeekReasoningEffort,
  clampReasoningEffort,
  normalizeReasoningEffort,
  REASONING_EFFORT_RANKS,
  REASONING_EFFORT_TIERS,
} from './reasoning-effort';
export { ModelRegistry } from './registry';
export {
  clampOutputTokens,
  MIN_OUTPUT_TOKENS,
  OUTPUT_TOKEN_CEILING,
  outputClampMargin,
} from './token-limits';
export { buildRuntimeSnapshotId, RUNTIME_SNAPSHOT_PREFIX } from './types';
export type {
  AvailableModelInfo,
  ModelCapabilities,
  ModelEntry,
  ModelGenerationConfig,
  ReasoningEffort,
  ResolvedModel,
  RuntimeModelSnapshot,
};

/** 模块级模型注册表单例（应用全局唯一） */
export const modelRegistry = new ModelRegistry({
  entries: BUILTIN_MODELS,
  defaultModelByKind: DEFAULT_MODEL_BY_KIND,
  defaultKind: DEFAULT_KIND,
});
