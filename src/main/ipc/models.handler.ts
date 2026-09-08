// src/main/ipc/models.handler.ts
// 模型域 handler（models:list + models:listBuiltin + models:test）
// ──────────────────────────────────────────────────────────────
// 职责：
// - models:list：暴露主进程 modelRegistry 中**已配置可用**的模型清单
//   （对齐同类桌面 LLM 客户端：配置好才显示，未配置不出现——没有就是没有）
//   仅适用于聊天框模型选择器
// - models:listBuiltin：厂商内置模型全集（不依赖 keychain 配置状态）——
//   配置页数据源（配置页恰恰为未配置用户服务，"配置好才显示"会造成死锁）
// - models:test：连通性测试——真实 HTTP 探测供应商端点（不落库、不改状态）
// ──────────────────────────────────────────────────────────────

import type {
  AvailableModelInfo,
  ModelsListBuiltinRes,
  ModelsListRes,
  TestModelRes,
} from '@code-agent/shared/main';
import { AppError, ErrorCode } from '@code-agent/shared/main';

import { getAppConfig } from '../config';
import { runtimeModelStore } from '../infra/ai/llm-client/ai-provider';
import { modelRegistry } from '../infra/ai/models';
import { runtimeModelKeychainKey } from '../infra/ai/models/runtime-model-store';
import type { ProviderKind } from '../infra/ai/providers/types';
import { isBlockedAddress, isBlockedHostname } from '../infra/ai/tools/url-guard';
import { getSecret } from '../infra/storage/keychain';

/** 连通性测试超时（毫秒） */
const TEST_TIMEOUT_MS = 10_000;

/** 根地址需拼接 /v1 的供应商（与 ProviderRegistry 拼接规则一致） */
const V1_PREFIX_KINDS: readonly ProviderKind[] = ['deepseek', 'openai', 'ollama'];

/**
 * 拼接探测目标 URL
 *
 * - anthropic：{base}/v1/messages（Anthropic 原生协议）
 * - deepseek/openai/ollama：{base}/v1/chat/completions（registry 拼接 /v1）
 * - 其余 OpenAI Compatible：{base}/chat/completions（默认地址已含 /v1 路径）
 */
function buildTestUrl(providerKind: ProviderKind, baseUrl: string): string {
  if (providerKind === 'anthropic') {
    return `${baseUrl}/v1/messages`;
  }
  const root = V1_PREFIX_KINDS.includes(providerKind) ? `${baseUrl}/v1` : baseUrl;
  return `${root}/chat/completions`;
}

/** models 域 handler（定义表驱动，InferHandlers 编译期约束） */
export const modelsHandlers = {
  /**
   * 模型清单（对话区/设置页共用）：返回用户显式配置且启用的模型记录
   *
   * 语义（2026-09-04 与用户确认）：
   * - 一个模型一条记录，设置页配置/启停后此处才出现（配置一个显示一个）。
   * - 服务商模式的记录同样存于 runtimeModelStore（providerKind + 具体 modelId，
   *   API Key 走厂商级 keychain）——服务商直连 = 配 Key 即用，但"模型"本身
   *   由配置弹窗选择并保存，不做"未配置就凭空并入"（无论默认模型或全量内置）。
   * - 真实数据源 = runtimeModelStore（用户配置的模型唯一入口）。
   *   厂商内置模型全集在配置页经 listBuiltin 提供（作为服务商模式的下拉候选）。
   */
  list: async (): Promise<ModelsListRes> => {
    const records = await runtimeModelStore.list();
    const models: AvailableModelInfo[] = [];
    for (const r of records) {
      if (!r.isEnabled) continue;
      const entry = modelRegistry.findBuiltin(r.modelId);
      models.push({
        id: r.modelId,
        label: r.displayName ?? entry?.displayName ?? r.modelId,
        providerKind: r.providerKind,
        isRuntime: true,
        capabilities: { ...(entry?.capabilities ?? {}) } as Record<string, unknown>,
      });
    }
    return { models };
  },

  /**
   * 厂商内置模型全集（配置页下拉数据源）
   *
   * 不做 keychain 过滤：配置页为未配置用户服务，需展示厂商全部官方模型
   * 供选择（未配置也能看到要配什么）。providerKind 省略时返回全部厂商。
   */
  listBuiltin: async (input: {
    providerKind?: ProviderKind | undefined;
  }): Promise<ModelsListBuiltinRes> => {
    const all = modelRegistry.listModels();
    const builtins = all.filter(
      (m) =>
        !m.isRuntime && (input.providerKind === undefined || m.providerKind === input.providerKind),
    );
    return {
      models: builtins.map((m) => ({
        id: m.id,
        label: m.label,
        providerKind: m.providerKind,
        isRuntime: m.isRuntime,
        capabilities: { ...m.capabilities } as Record<string, unknown>,
      })),
    };
  },

  /**
   * 连通性测试：POST 最小请求到供应商端点
   *
   * - API Key 回退链：input.apiKey → 提供商 keychain → 运行时模型 keychain
   * - 401/403 判为密钥无效；其余非 2xx 返回状态码；网络异常返回错误信息
   * - 只读探测：不落库、不注册、不消耗业务数据
   */
  test: async (input: {
    providerKind: ProviderKind;
    modelId?: string | undefined;
    baseUrl: string | undefined;
    apiKey: string | undefined;
  }): Promise<TestModelRes> => {
    const { providerKind } = input;
    const baseUrl = input.baseUrl ?? getAppConfig().providers[providerKind];

    // 2026-09-08 安全修复（密钥外泄原语）：渲染层此前可传任意 baseUrl 并省略
    // apiKey，主进程会回退 keychain 里的真实密钥并发往该 URL（无白名单）。
    // 现在：显式 baseUrl 必须同时显式提供 apiKey——不允许用真实密钥探测
    // 任意端点；同时拒绝私网/链路本地/云元数据地址（SSRF）。
    // 注意：loopback（localhost/127.0.0.1）**放行**——本地 Ollama / 自建推理
    // 服务是合法用法（providerKind='ollama' 的默认端点就是 localhost:11434）。
    if (input.baseUrl !== undefined) {
      if (input.apiKey === undefined) {
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          '自定义 baseUrl 时必须同时提供 apiKey（不允许用已保存的密钥探测任意端点）',
        );
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(input.baseUrl);
      } catch {
        throw new AppError(ErrorCode.INVALID_INPUT, `非法的 baseUrl：${input.baseUrl}`);
      }
      if (isBlockedHostname(parsedUrl.hostname) || isBlockedAddress(parsedUrl.hostname)) {
        throw new AppError(
          ErrorCode.INVALID_INPUT,
          `baseUrl 指向受限地址（内网/元数据）：${parsedUrl.hostname}`,
        );
      }
    }

    // API Key 回退链（显式优先）
    let apiKey = input.apiKey;
    if (apiKey === undefined) {
      apiKey = (await getSecret(`${providerKind}-api-key`)) ?? undefined;
    }
    if (apiKey === undefined && input.modelId !== undefined) {
      apiKey = (await getSecret(runtimeModelKeychainKey(input.modelId))) ?? undefined;
    }

    const url = buildTestUrl(providerKind, baseUrl);
    const model = input.modelId ?? 'ping';
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers:
          providerKind === 'anthropic'
            ? {
                'content-type': 'application/json',
                'x-api-key': apiKey ?? '',
                'anthropic-version': '2023-06-01',
              }
            : {
                'content-type': 'application/json',
                ...(apiKey !== undefined ? { authorization: `Bearer ${apiKey}` } : {}),
              },
        body: JSON.stringify({
          model,
          // biome-ignore lint/style/useNamingConvention: 供应商 API 协议字段（snake_case）
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
        signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
      });
      if (response.ok) {
        return { ok: true };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: 'API Key 无效或未授权' };
      }
      return { ok: false, error: `HTTP ${response.status}` };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message };
    }
  },
};
