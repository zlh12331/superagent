// generation-options.ts：生成参数构建——采样温度/推理力度/输出 token 上限三路合成
// 规则：推理模型不给 temperature/topP（与 reasoning 冲突）；thinking 覆盖可关推理
import { getProviderName } from '../providers';
import { clampDeepSeekReasoningEffort, type ReasoningEffort } from './reasoning-effort';
import { clampOutputTokens } from './token-limits';
import type { ResolvedModel } from './types';

/** 构建产物：采样参数 + 供应商选项（reasoningEffort）+ 输出上限（可 undefined = 不设限） */
export interface GenerationOptions {
  readonly samplingOptions: {
    readonly temperature?: number;
    readonly topP?: number;
  };
  readonly providerOptions: Record<string, { readonly reasoningEffort: string }> | undefined;
  readonly maxOutputTokens: number | undefined;
}

/** thinking 覆盖值：推理力度档或 'off'（显式关闭推理） */
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
