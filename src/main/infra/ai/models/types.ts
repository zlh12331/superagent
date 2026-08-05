// src/main/infra/ai/models/types.ts
// 模型领域层类型定义（模型级路由的单一真源）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 定义 ModelEntry（模型条目：模型 id → 供应商 + 能力 + 生成参数）
// - 定义 ModelCapabilities（能力元数据，功能路由用：vision / contextWindowSize / fastOnly / reasoning）
// - 定义 RuntimeModelSnapshot（运行时模型快照：用户手动配置的模型）
//
// 设计（对标 qwen-code 的 models/types.ts）：
// - 模型是路由的最小单元（区别于旧设计的"供应商"级路由）
// - 模型 id 全局唯一（如 'deepseek-v4-flash'），ModelRegistry 负责 id → 供应商解析
// - 运行时快照让"手动配置的模型"（设置 UI 添加的自定义端点）与内置模型并存，
//   来源可追踪（$runtime|providerKind|modelId）
// - 本文件不依赖任何 SDK / config / keychain，纯类型与常量
// ──────────────────────────────────────────────────────────────

import type { ProviderKind } from '../providers/types';
import type { ReasoningEffort } from './reasoning-effort';

/** re-export：思考强度档位（统一阶梯定义在 reasoning-effort.ts） */
export type { ReasoningEffort };

/**
 * 模型能力元数据（功能路由依据）
 *
 * 与 qwen-code ModelCapabilities 对齐：能力缺失时按最保守策略路由。
 */
export interface ModelCapabilities {
  /** 是否支持视觉（图像）输入 */
  vision?: boolean;
  /** 上下文窗口大小（token 数；token 预算估算用） */
  contextWindowSize?: number;
  /**
   * 模型单次响应最大输出 token 数（模型固有属性）
   *
   * 各模型差异很大（DeepSeek v4 官方 384K / GPT-4o 16K / Claude 64K / 本地 8K），
   * 钳制逻辑用 min(用户配置, 本字段) 作为上限；未配置时回退全局默认
   * OUTPUT_TOKEN_CEILING（token-limits.ts）。
   */
  maxOutputTokens?: number;
  /** 是否仅用于"快模型"场景（标题生成 / 摘要 / 子代理等 side query） */
  fastOnly?: boolean;
  /**
   * 是否思考模型（reasoning，输出前先产生思维链）
   *
   * 思考模式特性（DeepSeek 官方文档）：
   * - 默认开启，effort 默认 high
   * - 不支持 temperature / top_p / presence_penalty / frequency_penalty
   *   （设置不报错但不生效）
   * - 带 tools 的多轮请求必须完整回传 reasoning_content，否则 400
   */
  reasoning?: boolean;
}

/**
 * 模型级生成参数默认值（透传给 AI SDK 的生成配置）
 */
export interface ModelGenerationConfig {
  /** 采样温度（reasoning 模型忽略：思考模式不支持） */
  temperature?: number;
  /** 单次响应最大 token 数 */
  maxTokens?: number;
  /** 核采样 top_p（reasoning 模型忽略：思考模式不支持） */
  topP?: number;
  /** 思考强度（仅 reasoning 模型生效，经 providerOptions.reasoningEffort 透传） */
  reasoningEffort?: ReasoningEffort;
  /**
   * 重试次数上限（默认 2，即最多 3 次尝试）
   *
   * 对标 qwen ContentGeneratorConfig.maxRetries：每模型可配。
   */
  maxRetries?: number;
  /**
   * 单次请求总超时毫秒数（防重试链无限挂起）
   *
   * 对标 qwen ContentGeneratorConfig.timeout；缺省不设超时。
   * 超时语义与用户中断一致（重试链立即停止，不重试）。
   */
  timeoutMs?: number;
  /** 供应商特有参数（透传，如 thinking 开关） */
  extra?: Record<string, unknown>;
}

/**
 * 模型条目：模型级定义（内置模型表的行）
 *
 * id 全局唯一；同一供应商可挂多个模型条目（默认模型 + 快模型 + 备选）。
 */
export interface ModelEntry {
  /** 模型 id（全局唯一，如 'deepseek-v4-flash'） */
  readonly id: string;
  /** 所属供应商（决定 keychain key / baseUrl / SDK 工厂） */
  readonly providerKind: ProviderKind;
  /** 显示名称（设置 UI 展示；缺省用 id） */
  readonly displayName?: string;
  /** 能力元数据（功能路由依据） */
  readonly capabilities?: ModelCapabilities;
  /** 生成参数默认值（模型级，覆盖供应商级） */
  readonly generationConfig?: ModelGenerationConfig;
}

/**
 * 运行时模型快照（用户手动配置的模型）
 *
 * 触发场景：设置 UI 添加自定义 OpenAI-compatible 端点 / 手动填 API Key 的模型。
 * 与 qwen-code RuntimeModelSnapshot 对齐：注册表外的模型以快照形式持久，
 * 与内置模型统一走 ModelRegistry.resolve 解析。
 */
export interface RuntimeModelSnapshot {
  /** 快照 id（$runtime|providerKind|modelId，模型注册表键） */
  readonly id: string;
  /** 所属供应商（自定义端点通常挂 'openai-compatible' 协议类） */
  readonly providerKind: ProviderKind;
  /** 模型 id */
  readonly modelId: string;
  /** 显式 API Key（覆盖 keychain 读取） */
  readonly apiKey?: string;
  /** 显式 baseUrl（覆盖供应商默认端点） */
  readonly baseUrl?: string;
  /** 快照创建时间（Unix timestamp 毫秒） */
  readonly createdAt: number;
}

/**
 * 模型解析结果（ModelRegistry.resolve 的产物）
 *
 * 已应用默认值 + 运行时快照覆盖，可直接驱动 provider 工厂创建。
 */
export interface ResolvedModel {
  /** 实际使用的模型 id */
  readonly modelId: string;
  /** 所属供应商（决定工厂 / keychain / baseUrl） */
  readonly providerKind: ProviderKind;
  /** 能力元数据（已应用默认值 {}） */
  readonly capabilities: ModelCapabilities;
  /** 生成参数默认值 */
  readonly generationConfig: ModelGenerationConfig | undefined;
  /** 是否运行时快照注册的模型 */
  readonly isRuntime: boolean;
  /** 运行时快照携带的显式 API Key（undefined = 走 keychain） */
  readonly explicitApiKey: string | undefined;
  /** 运行时快照携带的显式 baseUrl（undefined = 供应商默认端点） */
  readonly explicitBaseUrl: string | undefined;
}

/**
 * 模型列表条目（设置 UI 下拉展示）
 */
export interface AvailableModelInfo {
  readonly id: string;
  readonly label: string;
  readonly providerKind: ProviderKind;
  /** 是否运行时快照注册（区别于内置模型） */
  readonly isRuntime: boolean;
  readonly capabilities: ModelCapabilities;
}

/** 运行时快照 id 前缀（$ 与 | 在真实模型 id 中几乎不可能出现） */
export const RUNTIME_SNAPSHOT_PREFIX = '$runtime|';

/** 生成运行时快照 id：$runtime|providerKind|modelId */
export function buildRuntimeSnapshotId(providerKind: ProviderKind, modelId: string): string {
  return `${RUNTIME_SNAPSHOT_PREFIX}${providerKind}|${modelId}`;
}
