// src/main/infra/memory-hub/llm-config.ts
// 蒸馏 LLM 配置解析：复用应用已配置的默认供应商与 Keychain 密钥
// ──────────────────────────────────────────────────────────────
// 设计：
// - 模型来源：设置 ai.defaultModel（渲染层 settings-store 写穿透 SQLite）
// - 供应商解析：ModelRegistry.resolve（运行时自定义模型含显式 baseUrl/apiKey 时优先）
// - 协议约束：MemoryCore 蒸馏仅支持 OpenAI-compatible 端点（llm-resolver 直通
//   openai 形态）；anthropic 协议不兼容 → 返回 undefined 优雅降级（L0 照常，
//   L1 提取停用并留痕）
// - URL 拼接规则对齐 providers/registry 工厂：deepseek/openai/ollama 根地址
//   需补 /v1，其余 kind 的 config 值已是完整 OpenAI 兼容路径
// ──────────────────────────────────────────────────────────────

import { getAppConfig } from '../../config';
import { logger } from '../../utils/logger';
import { modelRegistry } from '../ai/models';
import type { ProviderKind } from '../ai/providers';
import { providerRegistry, toKeychainKey } from '../ai/providers';
import { getSecret } from '../storage/keychain';
import { readSetting } from '../storage/settings-pref';
import type { MemoryHubLlmConfig } from './memory-hub-service';

/** 根地址不含协议路径、需补 /v1 的供应商（对齐 BUILTIN_FACTORIES 拼接规则） */
const V1_SUFFIX_KINDS: ReadonlySet<ProviderKind> = new Set(['deepseek', 'openai', 'ollama']);

/** MemoryCore 蒸馏不支持的协议（非 OpenAI-compatible） */
const INCOMPATIBLE_KINDS: ReadonlySet<ProviderKind> = new Set(['anthropic']);

const TAG = '[memory-hub]';

/**
 * 解析蒸馏 LLM 配置（用户默认模型 → 供应商 → keychain）
 *
 * @returns 可用配置；不可用（协议不兼容 / 未配置 Key / 设置读取失败）时 undefined
 */
export async function resolveDistillLlmConfig(): Promise<MemoryHubLlmConfig | undefined> {
  try {
    // 1. 用户默认模型（设置 ai 对象整体 JSON 落库；未配置时用默认供应商默认模型）
    const aiSettings = readSetting('ai') as { defaultModel?: unknown } | undefined;
    const requestedModel =
      typeof aiSettings?.defaultModel === 'string' && aiSettings.defaultModel.length > 0
        ? aiSettings.defaultModel
        : undefined;

    const resolved = modelRegistry.resolve(requestedModel);
    const kind = resolved.providerKind;

    // 默认模型已被用户停用 → 蒸馏降级（L0 照常，L1 提取停用）
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

    // 2. baseUrl：运行时模型显式覆盖 > config 根地址映射
    const root = resolved.explicitBaseUrl ?? getAppConfig().providers[kind];
    const baseUrl = V1_SUFFIX_KINDS.has(kind) ? `${root}/v1` : root;

    // 3. apiKey：运行时模型显式覆盖 > keychain；免 Key 供应商（ollama）为空串
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
