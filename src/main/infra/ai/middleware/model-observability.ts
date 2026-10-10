import type { LanguageModelMiddleware } from 'ai';
import { logger } from '../../../utils/logger';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const modelObservabilityMiddleware: LanguageModelMiddleware = {
  wrapGenerate({ doGenerate, model }) {
    const startedAt = Date.now();
    return doGenerate().then(
      (result) => {
        logger.debug(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            ...(result.usage?.inputTokens !== undefined
              ? { inputTokens: result.usage.inputTokens }
              : {}),
            ...(result.usage?.outputTokens !== undefined
              ? { outputTokens: result.usage.outputTokens }
              : {}),
          },
          '模型生成调用完成',
        );
        return result;
      },
      (error) => {
        logger.warn(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          },
          '模型生成调用失败',
        );
        throw error;
      },
    );
  },

  wrapStream({ doStream, model }) {
    const startedAt = Date.now();
    return doStream().then(
      (result) => {
        logger.debug(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
          },
          '模型流式调用已建立',
        );
        return result;
      },
      (error) => {
        logger.warn(
          {
            provider: model.provider,
            modelId: model.modelId,
            latencyMs: Date.now() - startedAt,
            error: errorMessage(error),
          },
          '模型流式调用启动失败',
        );
        throw error;
      },
    );
  },
};
