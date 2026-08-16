// src/main/ipc/settings.handler.ts
// Settings 域 IPC handler（API Key 管理 + 遥测级别 + 自定义模型，定义表驱动）
//
// 实现 10 个请求-响应方法：
// - getAll / set   渲染层用户设置（app_settings 表，SQLite 单一真源）
// - getApiKey / setApiKey / deleteApiKey   API Key 管理（safeStorage 加密存 keychain）
// - getTelemetryLevel / setTelemetryLevel  遥测级别开关
// - addRuntimeModel / removeRuntimeModel / listRuntimeModels  自定义模型（运行时快照）
//
// 设计要点：
// - 不依赖 ServiceContainer：keychain / telemetry-pref / runtimeModelStore 均为无状态模块单例
// - runtimeModelStore 单例在 ai-provider 层（与 llmClient 同层），启动时 loadAll()
// - keychain key 命名规则：'<provider>-api-key' / 'runtime:<modelId>'

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';

import { llmClient, runtimeModelStore } from '../infra/ai/llm-client/ai-provider';
import { toKeychainKey } from '../infra/ai/providers';
import type { IPermissionService } from '../infra/ai/tools/permission-service';
import { readApprovalModeSync, writeApprovalMode } from '../infra/storage/approval-pref';
import { deleteSecret, getSecret, setSecret } from '../infra/storage/keychain';
import { readAllSettings, writeSetting } from '../infra/storage/settings-pref';
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
    // S1：读取全部渲染层设置（app_settings 表快照；启动时 main.tsx 顶层 await 调用）
    getAll: async () => {
      return { settings: readAllSettings() };
    },

    // S1：写穿透落库（渲染层内存态变更后 fire-and-forget）
    set: async (input) => {
      writeSetting(input.key, input.value);
      return { ok: true };
    },

    // 查询 API Key 配置状态：仅返回布尔（P0 安全修复）
    // 明文不回传渲染层（对比 listRuntimeModels 的剥 key 策略，此处对齐），
    // 渲染层只关心"是否已配置"，明文仅主进程内部（llmClient）消费
    getApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      const apiKey = await getSecret(key);
      return { configured: apiKey !== null };
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
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      });
      // 缓存失效：同模型下次 getModel 重建（读取新 baseUrl/apiKey）
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    // settings:updateRuntimeModel - 编辑 + 启停（partial 语义）
    updateRuntimeModel: async (input) => {
      await runtimeModelStore.update({
        modelId: input.modelId,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
      });
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    // settings:removeRuntimeModel - 删除自定义模型
    removeRuntimeModel: async (input) => {
      await runtimeModelStore.remove(input.modelId);
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    // settings:listRuntimeModels - 列出自定义模型（设置页列表展示）
    listRuntimeModels: async () => {
      const records = await runtimeModelStore.list();
      return {
        models: records.map((r) => ({
          modelId: r.modelId,
          providerKind: r.providerKind,
          baseUrl: r.baseUrl,
          displayName: r.displayName,
          isEnabled: r.isEnabled,
          createdAt: r.createdAt,
        })),
      };
    },
  };
}
