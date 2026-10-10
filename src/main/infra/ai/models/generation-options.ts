import { getProviderName } from '../providers';
import { clampDeepSeekReasoningEffort, type ReasoningEffort } from './reasoning-effort';
import { clampOutputTokens } from './token-limits';
import type { ResolvedModel } from './types';

/**
 * 生成选项（streamText / generateText 入参的领域投影）
 */
export interface GenerationOptions {
  /** 采样参数（reasoning 模型为空：思考模式不支持采样） */
  readonly samplingOptions: {
    readonly temperature?: number;
    readonly topP?: number;
  };
  /** 思考强度（providerOptions：key = provider name） */
  readonly providerOptions: Record<string, { readonly reasoningEffort: string }> | undefined;
  /** 输出 token 上限（窗口预算钳制后的 maxOutputTokens） */
  readonly maxOutputTokens: number | undefined;
}

/**
 * 思考强度请求档位（用户可配置）
 *
 * - ReasoningEffort：覆盖模型级默认档位
 * - 'off'：不注入 providerOptions（模型默认行为）
 * - undefined：使用模型级 generationConfig.reasoningEffort
 */
export type ThinkingOverride = ReasoningEffort | 'off';

/**
 * 构造模型生成选项（纯函数，llm-client 与 agent-service 共用）
 *
 * @param resolved 模型解析结果（ModelRegistry.resolve 产物）
 * @param promptTokens 估算的 prompt 大小（含 system；输出预算钳制用）
 * @param thinkingOverride 用户思考强度档位（可选；覆盖模型级默认）
 * @param temperatureOverride 用户采样温度（可选；覆盖模型级 generationConfig.temperature）
 */
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
