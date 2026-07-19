// src/main/ipc/handlers/settings.handler.ts
// 设置域 IPC handler（薄层）
// 设计文档 §4.1 分层架构：handler 只做参数校验 + 调 service
// §6.2 ProjectSetting 模型 / §1.2 决策 5 API Key 存 keychain
//
// 职责：
// 1. 注册 settings 域 4 个 channel（get/set/setApiKey/testApiKey）
// 2. 通过 wrap() 统一包装：sender 校验 + traceId + zod 校验 + 错误处理
// 3. setApiKey 接收 { provider, apiKey }，调用 setApiKey(provider, apiKey)
//
// 注意：
// - handler 不持有状态，不直接访问 Prisma / keychain
// - get 从 input 提取 projectId
// - set 透传 input（ProjectSettingUpdateInputSchema 已校验）
// - setApiKey 使用内联 schema（provider 枚举 + apiKey 非空字符串）
// - testApiKey 透传 input（TestApiKeyInputSchema 已校验 provider 枚举）

import {
  IPC_CHANNELS,
  ProjectSettingUpdateInputSchema,
  TestApiKeyInputSchema,
} from '@novel-writer/shared';
import { z } from 'zod';
import {
  getProjectSettings,
  setApiKey,
  testApiKey,
  updateProjectSettings,
} from '../../services/settings.service';
import { wrap } from '../../utils/wrap';

/**
 * 注册 settings 域 IPC handler
 *
 * 注册 4 个 channel：
 * - settings:get        → getProjectSettings
 * - settings:set        → updateProjectSettings
 * - settings:setApiKey  → setApiKey
 * - settings:testApiKey → testApiKey
 */
export function registerSettingsHandlers(): void {
  // 获取项目设置：从 input 提取 projectId
  wrap(IPC_CHANNELS.SETTINGS_GET, z.object({ projectId: z.string().min(1) }), (input) =>
    getProjectSettings(input.projectId),
  );

  // 更新项目设置（upsert）：透传 input（ProjectSettingUpdateInputSchema 已校验）
  wrap(IPC_CHANNELS.SETTINGS_SET, ProjectSettingUpdateInputSchema, (input) =>
    updateProjectSettings(input),
  );

  // 存储 API Key 到 keychain：从 input 提取 provider + apiKey
  // provider 枚举与 service 函数签名对齐（'deepseek' | 'ollama'）
  wrap(
    IPC_CHANNELS.SETTINGS_SET_API_KEY,
    z.object({
      provider: z.enum(['deepseek', 'ollama']),
      apiKey: z.string().min(1),
    }),
    (input) => setApiKey(input.provider, input.apiKey),
  );

  // 测试 API Key 有效性：透传 input（TestApiKeyInputSchema 已校验 provider 枚举）
  wrap(IPC_CHANNELS.SETTINGS_TEST_API_KEY, TestApiKeyInputSchema, (input) =>
    testApiKey(input.provider),
  );
}
