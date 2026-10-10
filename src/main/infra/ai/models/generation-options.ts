import { getProviderName } from '../providers';
import { clampDeepSeekReasoningEffort, type ReasoningEffort } from './reasoning-effort';
import { clampOutputTokens } from './token-limits';
import type { ResolvedModel } from './types';

export interface GenerationOptions {
  readonly samplingOptions: {
    readonly temperature?: number;
    readonly topP?: number;
  };
  readonly providerOptions: Record<string, { readonly reasoningEffort: string }> | undefined;
  readonly maxOutputTokens: number | undefined;
}

export type ThinkingOverride = ReasoningEffort | 'off';

export function buildGenerationOptions(
  resolved: ResolvedModel,
  promptTokens: number,
  thinkingOverride?: ThinkingOverride,
  temperatureOverride?: number,
): GenerationOptions {
  const generationConfig = resolved.generationConfig;
  const isReasoning = resolved.capabilities.reasoning === true;

  const temperature = temperatureOverride ?? generationConfig?.temperature;
  const samplingOptions = isReasoning
    ? {}
    : {
        ...(temperature !== undefined ? { temperature } : {}),
        ...(generationConfig?.topP !== undefined ? { topP: generationConfig.topP } : {}),
      };

  const effort = thinkingOverride ?? generationConfig?.reasoningEffort;
  const providerOptions =
    isReasoning && effort !== undefined && effort !== 'off'
      ? {
          [getProviderName(resolved.providerKind)]: {
            reasoningEffort:
              resolved.providerKind === 'deepseek'
                ? clampDeepSeekReasoningEffort(resolved.modelId, effort)
                : effort,
          },
        }
      : undefined;

  const maxOutputTokens = clampOutputTokens({
    ceiling: generationConfig?.maxTokens,
    modelMaxOutputTokens: resolved.capabilities.maxOutputTokens,
    contextWindowSize: resolved.capabilities.contextWindowSize,
    promptTokens,
  });

  return { samplingOptions, providerOptions, maxOutputTokens };
}
