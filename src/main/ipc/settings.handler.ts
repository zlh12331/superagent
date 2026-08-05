// src/main/ipc/settings.handler.ts
// Settings 域 IPC handler（API Key 管理 + 遥测级别 + 自定义模型，定义表驱动）
//
// 实现 8 个请求-响应方法：
// - getApiKey / setApiKey / deleteApiKey   API Key 管理（safeStorage 加密存 keychain）
// - getTelemetryLevel / setTelemetryLevel  遥测级别开关
// - addRuntimeModel / removeRuntimeModel / listRuntimeModels  自定义模型（运行时快照）
//
// 设计要点：
// - 不依赖 ServiceContainer：keychain / telemetry-pref / runtimeModelStore 均为无状态模块单例
// - runtimeModelStore 单例在 ai-provider 层（与 llmClient 同层），启动时 loadAll()
// - keychain key 命名规则：'<provider>-api-key' / 'runtime:<modelId>'

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import { llmClient, runtimeModelStore } from '../infra/ai/ai-provider';
import type { IPermissionService } from '../infra/ai/permission-service';
import { toKeychainKey } from '../infra/ai/providers';
import { readApprovalModeSync, writeApprovalMode } from '../infra/storage/approval-pref';
import { deleteSecret, getSecret, setSecret } from '../infra/storage/keychain';
import { readTelemetryLevelSync, writeTelemetryLevel } from '../infra/storage/telemetry-pref';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * Settings 域 handler 工厂
 *
 * 依赖注入：
 * - permissionService：审批模式设置（运行时决策更新）
 */
export function createSettingsHandlers(params: {
  permissionService: IPermissionService;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['settings'] {
  const { permissionService } = params;
  return {
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

    // 查询审批模式：同步读取（启动时 PermissionService 已应用同一份配置）
    getApprovalMode: async () => {
      const mode = readApprovalModeSync();
      return { mode };
    },

    // 设置审批模式：持久化 + 更新 PermissionService 运行时决策
    setApprovalMode: async (input) => {
      await writeApprovalMode(input.mode);
      permissionService.setApprovalMode(input.mode);
      return { ok: true, mode: input.mode };
    },

    // settings:addRuntimeModel - 添加自定义模型（持久化 + 注册 + 缓存失效）
    addRuntimeModel: async (input) => {
      await runtimeModelStore.add({
        modelId: input.modelId,
        providerKind: input.providerKind,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
      });
      // 缓存失效：同模型下次 getModel 重建（读取新 baseUrl/apiKey）
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    // settings:removeRuntimeModel - 删除自定义模型
    removeRuntimeModel: async (input) => {
      await runtimeModelStore.remove(input.modelId);
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    // settings:listRuntimeModels - 列出自定义模型（设置页展示）
    listRuntimeModels: async () => {
      const snapshots = await runtimeModelStore.list();
      return {
        models: snapshots.map((s) => ({
          modelId: s.modelId,
          providerKind: s.providerKind,
          baseUrl: s.baseUrl,
          createdAt: s.createdAt,
        })),
      };
    },
  };
}
