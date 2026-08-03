// src/main/ipc/settings.handler.ts
// Settings 域 IPC handler（API Key 管理 + 遥测级别开关，定义表驱动）
//
// 实现 5 个请求-响应方法：
// - getApiKey         查询指定提供商的 API Key（返回明文或 null）
// - setApiKey         设置 API Key（主进程通过 safeStorage 加密后存储到 keychain）
// - deleteApiKey      删除指定提供商的 API Key
// - getTelemetryLevel 查询遥测级别（off / error-only / full）
// - setTelemetryLevel 设置遥测级别（修改后需重启生效）
//
// 设计要点：
// - 不依赖 ServiceContainer：keychain 和 telemetry-pref 是无状态模块函数
// - keychain key 命名规则：'<provider>-api-key'（如 'deepseek-api-key'）
// - safeStorage 加密失败（如 Linux 缺 libsecret）会抛错并返回 INTERNAL_ERROR

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import { toKeychainKey } from '../infra/ai/providers';
import { deleteSecret, getSecret, setSecret } from '../infra/storage/keychain';
import { readTelemetryLevelSync, writeTelemetryLevel } from '../infra/storage/telemetry-pref';
import type { IpcHandlerContext } from '../utils/wrap';

/** Settings 域 handler 实现 */
export const settingsHandlers: InferHandlers<
  typeof IPC_DEFINITIONS,
  IpcHandlerContext
>['settings'] = {
  // 查询 API Key：返回明文或 null（未设置时）
  // 渲染层据此判断是否已配置，未配置则引导用户进入设置页
  getApiKey: async (input) => {
    const key = toKeychainKey(input.provider);
    const apiKey = await getSecret(key);
    return { apiKey };
  },

  // 设置 API Key：渲染层传入明文，主进程加密后存储到 keychain
  // safeStorage 不可用时会抛 'safeStorage 加密不可用' 错误，wrap 捕获后返回 INTERNAL_ERROR
  setApiKey: async (input) => {
    const key = toKeychainKey(input.provider);
    await setSecret(key, input.apiKey);
    return { ok: true };
  },

  // 删除 API Key：未设置时也返回 ok=true（幂等）
  deleteApiKey: async (input) => {
    const key = toKeychainKey(input.provider);
    await deleteSecret(key);
    return { ok: true };
  },

  // 查询遥测级别：同步读取（initSentry 也用同一个函数）
  getTelemetryLevel: async () => {
    const level = readTelemetryLevelSync();
    return { level };
  },

  // 设置遥测级别：写入 JSON 文件，需重启应用生效
  setTelemetryLevel: async (input) => {
    await writeTelemetryLevel(input.level);
    return { ok: true, level: input.level };
  },
};
