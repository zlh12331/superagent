// src/main/ipc/settings.handler.ts
// Settings 域 IPC handler（API Key 管理 + 遥测级别开关）
//
// 注册 5 个请求-响应 channel：
// - settings:getApiKey         查询指定提供商的 API Key（返回明文或 null）
// - settings:setApiKey         设置 API Key（主进程通过 safeStorage 加密后存储到 keychain）
// - settings:deleteApiKey      删除指定提供商的 API Key
// - settings:getTelemetryLevel 查询遥测级别（off / error-only / full）
// - settings:setTelemetryLevel 设置遥测级别（修改后需重启生效）
//
// 设计要点：
// - 不依赖 ServiceContainer：keychain 和 telemetry-pref 是无状态模块函数
// - 入参 zod schema 来自 @novel-writer/shared（单一真源）
// - safeStorage 加密失败（如 Linux 缺 libsecret）会抛错并返回 INTERNAL_ERROR
// - keychain key 命名规则：'<provider>-api-key'（如 'deepseek-api-key'）

import {
  type DeleteApiKeyReq,
  DeleteApiKeyReqSchema,
  type DeleteApiKeyRes,
  type GetApiKeyReq,
  GetApiKeyReqSchema,
  type GetApiKeyRes,
  type GetTelemetryLevelRes,
  IPC_CHANNELS,
  type SetApiKeyReq,
  SetApiKeyReqSchema,
  type SetApiKeyRes,
  type SetTelemetryLevelReq,
  SetTelemetryLevelReqSchema,
  type SetTelemetryLevelRes,
} from '@novel-writer/shared';
import { deleteSecret, getSecret, setSecret } from '../infra/storage/keychain';
import { readTelemetryLevelSync, writeTelemetryLevel } from '../infra/storage/telemetry-pref';
import { wrap } from '../utils/wrap';

/**
 * 将 provider 转换为 keychain 的 key
 *
 * 命名规则：'<provider>-api-key'，与早期版本保持一致
 */
function toKeychainKey(provider: 'deepseek' | 'openai'): string {
  return `${provider}-api-key`;
}

/**
 * 注册 Settings 域 IPC handler
 *
 * 在 app.whenReady() 后调用一次，与其他 registerXxxHandlers 并列。
 *
 * 幂等性：重复调用会因 ipcMain.handle 对同一 channel 重复注册而抛错，
 * 但正常流程不会触发——本函数只在 whenReady 中调用一次。
 */
export function registerSettingsHandlers(): void {
  // 查询 API Key：返回明文或 null（未设置时）
  // 渲染层据此判断是否已配置，未配置则引导用户进入设置页
  wrap<GetApiKeyReq, GetApiKeyRes>(
    IPC_CHANNELS.SETTINGS_GET_API_KEY,
    GetApiKeyReqSchema,
    async (input) => {
      const key = toKeychainKey(input.provider);
      const apiKey = await getSecret(key);
      return { apiKey };
    },
  );

  // 设置 API Key：渲染层传入明文，主进程加密后存储到 keychain
  // safeStorage 不可用时会抛 'safeStorage 加密不可用' 错误，wrap 捕获后返回 INTERNAL_ERROR
  wrap<SetApiKeyReq, SetApiKeyRes>(
    IPC_CHANNELS.SETTINGS_SET_API_KEY,
    SetApiKeyReqSchema,
    async (input) => {
      const key = toKeychainKey(input.provider);
      await setSecret(key, input.apiKey);
      return { ok: true };
    },
  );

  // 删除 API Key：未设置时也返回 ok=true（幂等）
  wrap<DeleteApiKeyReq, DeleteApiKeyRes>(
    IPC_CHANNELS.SETTINGS_DELETE_API_KEY,
    DeleteApiKeyReqSchema,
    async (input) => {
      const key = toKeychainKey(input.provider);
      await deleteSecret(key);
      return { ok: true };
    },
  );

  // 查询遥测级别：同步读取（initSentry 也用同一个函数）
  // 入参为 void，schema 传 null（wrap 约定：null 表示无入参校验）
  wrap<void, GetTelemetryLevelRes>(IPC_CHANNELS.SETTINGS_GET_TELEMETRY_LEVEL, null, async () => {
    const level = readTelemetryLevelSync();
    return { level };
  });

  // 设置遥测级别：写入 JSON 文件，需重启应用生效
  wrap<SetTelemetryLevelReq, SetTelemetryLevelRes>(
    IPC_CHANNELS.SETTINGS_SET_TELEMETRY_LEVEL,
    SetTelemetryLevelReqSchema,
    async (input) => {
      await writeTelemetryLevel(input.level);
      return { ok: true, level: input.level };
    },
  );
}
