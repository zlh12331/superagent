// src/main/services/settings.service.ts
// 设置业务逻辑层
// 设计文档 §4.2 Services 层职责矩阵 / §6.2 ProjectSetting / AppSetting 模型
//
// 职责：
// 1. 项目设置管理（getProjectSettings / updateProjectSettings）
// 2. API Key 管理（setApiKey / testApiKey）
//
// 注意：
// - ProjectSetting 是单例（PK = projectId），upsert 创建/更新
// - API Key 存 keychain（设计文档 §1.2 决策 5）
// - testApiKey：Phase 5a 占位（实际 API 调用由 Phase 5b 实现）
// - 不与其他 service 互相依赖（设计文档 §4.4 禁止依赖方向）

import type { ProjectSetting, ProjectSettingUpdateInput } from '@novel-writer/shared';
import type { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../infra/prisma/client';
import { getSecret, setSecret } from '../infra/storage/keychain';
import { logger } from '../utils/logger';

/**
 * Keychain 中的 API Key 名称映射
 *
 * provider -> keychain 中存储的 secret key
 */
const API_KEY_NAMES = {
  deepseek: 'deepseek-api-key',
  ollama: 'ollama-api-key',
} as const;

/**
 * 默认项目设置（设置不存在时返回）
 *
 * 与 Prisma schema 中各字段的 @default 对齐：
 * - aiModel: "deepseek-v4-flash"
 * - aiTemperature: 0.7
 * - aiMaxTokens: 4096
 * - ragEnabled: true
 * - ragTopK: 5
 * - ragThreshold: 0.7
 * - customPrompts: "{}"（Prisma Json 默认值，这里用空对象）
 *
 * 注意：不使用 `as const`，避免 readonly 限制导致 Prisma 入参类型不兼容
 */
const DEFAULT_SETTINGS = {
  aiModel: 'deepseek-v4-flash',
  aiTemperature: 0.7,
  aiMaxTokens: 4096,
  ragEnabled: true,
  ragTopK: 5,
  ragThreshold: 0.7,
  customPrompts: {} as Record<string, unknown>,
};

/**
 * 获取项目设置
 *
 * 设置不存在时返回默认值（不持久化到 DB）。
 * 渲染层用返回值渲染设置页，用户主动保存时调用 updateProjectSettings 写入。
 * 不持久化的原因：避免空项目产生垃圾记录。
 */
export async function getProjectSettings(projectId: string): Promise<ProjectSetting> {
  const prisma = getPrismaClient();

  const found = await prisma.projectSetting.findUnique({
    where: { projectId },
  });

  if (found === null) {
    // 返回默认值，不持久化（避免空项目产生垃圾记录）
    return {
      projectId,
      ...DEFAULT_SETTINGS,
      updatedAt: new Date().toISOString(),
    };
  }

  return serializeProjectSetting(found);
}

/**
 * 更新项目设置（upsert：不存在则创建，存在则更新）
 *
 * - create：合并默认值，确保新记录拥有完整字段
 * - update：只更新用户显式传入的字段（过滤 undefined）
 *
 * 注意：projectId 是 PK，仅出现在 where / create，不参与 update payload
 * （exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined）
 */
export async function updateProjectSettings(
  input: ProjectSettingUpdateInput,
): Promise<ProjectSetting> {
  const prisma = getPrismaClient();
  logger.info({ projectId: input.projectId }, '更新项目设置');

  // 提取 projectId（PK，不参与 update payload）
  const { projectId, ...restInput } = input;

  // 构造 create 数据（合并默认值，确保新记录有完整字段）
  const createData = {
    projectId,
    aiModel: restInput.aiModel ?? DEFAULT_SETTINGS.aiModel,
    aiTemperature: restInput.aiTemperature ?? DEFAULT_SETTINGS.aiTemperature,
    aiMaxTokens: restInput.aiMaxTokens ?? DEFAULT_SETTINGS.aiMaxTokens,
    ragEnabled: restInput.ragEnabled ?? DEFAULT_SETTINGS.ragEnabled,
    ragTopK: restInput.ragTopK ?? DEFAULT_SETTINGS.ragTopK,
    ragThreshold: restInput.ragThreshold ?? DEFAULT_SETTINGS.ragThreshold,
    // Prisma Json 字段类型严格（InputJsonValue 不接受 Record<string, unknown>）
    // 用 as never 绕过类型检查（与 character.service.ts profile 字段模式一致）
    customPrompts: (restInput.customPrompts ?? DEFAULT_SETTINGS.customPrompts) as never,
  };

  // 构造 update 数据（只包含显式传入的字段，过滤 undefined）
  // exactOptionalPropertyTypes: true 下 Prisma 不接受显式 undefined
  const updateData = Object.fromEntries(
    Object.entries(restInput).filter(([, value]) => value !== undefined),
  );

  const upserted = await prisma.projectSetting.upsert({
    where: { projectId },
    create: createData,
    update: updateData as never,
  });

  return serializeProjectSetting(upserted);
}

/**
 * 存储 API Key 到 keychain
 *
 * @param provider 服务商（deepseek / ollama）
 * @param apiKey API Key 原文（会被 keychain 加密后存储）
 */
export async function setApiKey(
  provider: 'deepseek' | 'ollama',
  apiKey: string,
): Promise<{ ok: boolean }> {
  const keyName = API_KEY_NAMES[provider];
  await setSecret(keyName, apiKey);
  logger.info({ provider }, 'API Key 已存储到 keychain');
  return { ok: true };
}

/**
 * 测试 API Key 有效性
 *
 * Phase 5a 占位实现：
 * - Key 不存在时返回 ok=false
 * - Key 存在时也返回 ok=false（实际 API 调用由 Phase 5b 实现）
 *
 * Phase 5b 将通过实际调用 DeepSeek / Ollama API 健康检查接口验证 Key
 */
export async function testApiKey(
  provider: 'deepseek' | 'ollama',
): Promise<{ ok: boolean; latencyMs?: number }> {
  const keyName = API_KEY_NAMES[provider];
  const key = await getSecret(keyName);

  if (key === null) {
    return { ok: false };
  }

  // Phase 5a 占位：不实际调用 API
  // Phase 5b 实现：调用 deepseek/ollama 健康检查接口
  logger.info({ provider }, 'API Key 存在，但 Phase 5a 暂未实现实际调用');
  return { ok: false };
}

/**
 * 序列化 Prisma ProjectSetting 记录为 IPC 兼容的 ProjectSetting 类型
 *
 * - Date 字段转 ISO 字符串（IPC 传输）
 * - Json 字段断言为 Record<string, unknown>（Zod schema 兼容）
 */
function serializeProjectSetting(raw: RawProjectSetting): ProjectSetting {
  return {
    projectId: raw.projectId,
    aiModel: raw.aiModel,
    aiTemperature: raw.aiTemperature,
    aiMaxTokens: raw.aiMaxTokens,
    ragEnabled: raw.ragEnabled,
    ragTopK: raw.ragTopK,
    ragThreshold: raw.ragThreshold,
    customPrompts: raw.customPrompts as Record<string, unknown>,
    updatedAt: raw.updatedAt.toISOString(),
  };
}

/**
 * Prisma projectSetting.findUnique 返回的原始类型
 *
 * 使用 NonNullable 包裹，因为 findUnique 可能返回 null，
 * 而调用 serializeProjectSetting 时已确保非 null。
 */
type RawProjectSetting = NonNullable<
  Awaited<ReturnType<PrismaClient['projectSetting']['findUnique']>>
>;
