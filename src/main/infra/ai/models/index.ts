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

export const modelRegistry = new ModelRegistry({
  entries: BUILTIN_MODELS,
  defaultModelByKind: DEFAULT_MODEL_BY_KIND,
  defaultKind: DEFAULT_KIND,
});
