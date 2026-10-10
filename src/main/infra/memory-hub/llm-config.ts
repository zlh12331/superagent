// llm-config.ts：记忆蒸馏 LLM 配置解析——从默认模型推导 baseUrl/apiKey/model 供引擎调用
// 协议兼容性：上游只吃 OpenAI Compatible 形态，anthropic 直连不兼容则显式不接线
import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { modelRegistry } from '../ai/models';
import type { ProviderKind } from '../ai/providers';
import { providerRegistry, toKeychainKey } from '../ai/providers';
import { getSecret } from '../storage/keychain';
import { readSetting } from '../storage/settings-pref';
import type { MemoryHubLlmConfig } from './memory-hub-service';

const V1_SUFFIX_KINDS: ReadonlySet<ProviderKind> = new Set(['deepseek', 'openai', 'ollama']);

const INCOMPATIBLE_KINDS: ReadonlySet<ProviderKind> = new Set(['anthropic']);

const TAG = '[memory-hub]';

export async function resolveDistillLlmConfig(): Promise<MemoryHubLlmConfig | undefined> {
  try {
    const aiSettings = readSetting('ai') as { defaultModel?: unknown } | undefined;
    const requestedModel =
      typeof aiSettings?.defaultModel === 'string' && aiSettings.defaultModel.length > 0
        ? aiSettings.defaultModel
        : undefined;

    const resolved = modelRegistry.resolve(requestedModel);
    const kind = resolved.providerKind;

    if (!resolved.available) {
      logger.warn(
        { model: resolved.modelId },
        `${TAG} 蒸馏 LLM 未接线：默认模型已停用（L0 记录不受影响，L1 提取停用）`,
      );
      return undefined;
    }

    if (INCOMPATIBLE_KINDS.has(kind)) {
      logger.warn(
        { kind, model: resolved.modelId },
        `${TAG} 蒸馏 LLM 未接线：默认模型供应商协议不兼容（L0 记录不受影响，L1 提取停用）`,
      );
      return undefined;
    }

    const root = resolved.explicitBaseUrl ?? getAppConfig().providers[kind];
    const baseUrl = V1_SUFFIX_KINDS.has(kind) ? `${root}/v1` : root;

    let apiKey = resolved.explicitApiKey;
    if (apiKey === undefined) {
      const definition = providerRegistry.getDefinition(kind);
      if (definition.requiresApiKey) {
        const stored = await getSecret(toKeychainKey(kind));
        if (stored === null) {
          logger.warn(
            { kind },
            `${TAG} 蒸馏 LLM 未接线：供应商 API Key 未配置（L0 记录不受影响，L1 提取停用）`,
          );
          return undefined;
        }
        apiKey = stored;
      } else {
        apiKey = '';
      }
    }

    logger.info({ kind, model: resolved.modelId }, `${TAG} 蒸馏 LLM 已接线（复用应用供应商配置）`);
    return { baseUrl, apiKey, model: resolved.modelId };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      `${TAG} 蒸馏 LLM 解析失败（降级为占位配置）`,
    );
    return undefined;
  }
}
