// src/main/ipc/settings.handler.ts
// Settings 域 IPC handler（API Key 管理 + 遥测级别 + 自定义模型，定义表驱动）
//
// 实现 13 个请求-响应方法：
// - getAll / set   渲染层用户设置（app_settings 表，SQLite 单一真源）
// - exportSettings / importSettings   设置导出/导入（app_settings 全表 JSON；
//   keychain 凭据除外——safeStorage 本机绑定不可迁移）
// - getApiKey / setApiKey / deleteApiKey   API Key 管理（safeStorage 加密存 keychain）
// - getTelemetryLevel / setTelemetryLevel  遥测级别开关
// - addRuntimeModel / updateRuntimeModel / removeRuntimeModel / listRuntimeModels  自定义模型（运行时快照）
//
// 设计要点：
// - 不依赖 ServiceContainer：keychain / telemetry-pref / runtimeModelStore 均为无状态模块单例
// - runtimeModelStore 单例在 ai-provider 层（与 llmClient 同层），启动时 loadAll()
// - keychain key 命名规则：'<provider>-api-key' / 'runtime:<modelId>'

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type InferHandlers, type IPC_DEFINITIONS, SETTING_KEYS } from '@code-agent/shared/main';
import { app, dialog } from 'electron';

import { llmClient, resetAIProvider, runtimeModelStore } from '../infra/ai/llm-client/ai-provider';
import { toKeychainKey } from '../infra/ai/providers';
import type { IPermissionService } from '../infra/ai/tools/permission-service';
import { setMainLanguage } from '../infra/i18n';
import { applyProxyChange } from '../infra/network/proxy-applier';
import { readApprovalModeSync, writeApprovalMode } from '../infra/storage/approval-pref';
import {
  deleteSecret,
  getSecret,
  isEncryptionAvailable,
  setSecret,
} from '../infra/storage/keychain';
import { applySettingsImport, buildSettingsExportFile } from '../infra/storage/settings-io';
import { deleteSettings, readAllSettings, writeSetting } from '../infra/storage/settings-pref';
import { readTelemetryLevelSync, writeTelemetryLevel } from '../infra/storage/telemetry-pref';
import { broadcastSettingChanged } from '../main-events';
import { readJsonImportFile } from '../utils/json-file';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';
// 独立主题联动模块（无 service-container 依赖）——IPC 层引用它不会穿透
// 到 electron-updater 初始化链（2026-09-03 回归修复，见 window-theme.ts 头注释）
import { syncTitleBarOverlayFromTheme } from '../window-theme';

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
      const settings = readAllSettings();
      // 启动校正：窗口控件色（titleBarOverlay）按 SQLite 实际主题设置——
      // createWindow 时静态配置只反映默认值（dark），此处是权威同步时机
      syncTitleBarOverlayFromTheme(settings['theme']);
      return { settings };
    },

    // S1：写穿透落库（渲染层内存态变更后 fire-and-forget）
    set: async (input) => {
      writeSetting(input.key, input.value);
      // 主题变更联动窗口控件色（Windows titleBarOverlay，零新增 IPC 的主进程收口）
      if (input.key === 'theme') {
        syncTitleBarOverlayFromTheme(input.value);
      }
      // 语言变更同步主进程 i18n（工具 title 等下一回合生效；theme 同款主进程收口模式）
      if (input.key === 'language') {
        setMainLanguage(input.value);
      }
      // 34 号：代理是推送式急切副作用（setProxy/env/缓存重置），写入即应用（V5）
      if (input.key === 'proxy') {
        await applyProxyChange(input.value);
      }
      return { ok: true };
    },

    // settings:export - 导出 app_settings 全表 JSON（dialog 选保存路径）
    // keychain 凭据（safeStorage 加密的 API Key）不在 app_settings 表内，
    // 天然不含在导出文件中（本机绑定不可迁移，UI 文案注明）
    exportSettings: async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出设置',
        defaultPath: join(app.getPath('documents'), `settings-export-${stamp}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      if (canceled || filePath === undefined || filePath === '') {
        return { saved: false };
      }
      try {
        await writeFile(filePath, JSON.stringify(buildSettingsExportFile()), 'utf8');
        logger.info({ filePath }, '设置导出完成');
        return { saved: true, path: filePath };
      } catch (error) {
        logger.error({ error: String(error) }, '设置导出失败');
        throw error;
      }
    },

    // settings:import - 导入设置（读文件 → zod 校验 → 白名单过滤 → 单事务写入）
    // 逐键广播 settings:event:changed：主进程主动写入必须推送（P2-6 丢更新防线），
    // 渲染层 settings-store 收到即应用，无需重启
    importSettings: async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '导入设置',
        filters: [{ name: 'JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      const filePath = filePaths[0];
      if (canceled || filePath === undefined) {
        return { imported: 0, skipped: 0 };
      }
      const payload = await readJsonImportFile(filePath);
      const outcome = applySettingsImport(payload);
      for (const { key, value } of outcome.applied) {
        // 主题联动窗口控件色：与 settings:set 同一收口
        if (key === 'theme') {
          syncTitleBarOverlayFromTheme(value);
        }
        // 34 号：导入 proxy 键 → 主进程显式应用（CP2 fail 修复项：广播只达渲染层，
        // 推送式副作用必须在此收口，V8）
        if (key === 'proxy') {
          await applyProxyChange(value);
        }
        broadcastSettingChanged(key, value);
      }
      return { imported: outcome.imported, skipped: outcome.skipped };
    },

    // 恢复所有设置为默认（2026-09-29）：删除 SETTING_KEYS 全部键——app_settings
    // 回到新用户空表状态，缺失即默认（渲染层 applySettingsSnapshot({}) 回落
    // DEFAULT_SETTINGS；主进程各 readSetting 消费方均有 undefined→默认兜底，
    // 见 readCloseAction / isAutoCheckEnabled / syncTitleBarOverlayFromTheme）。
    // 默认值真源保持在渲染层 settings-store，主进程零默认值知识。
    // 不影响：keychain 凭据、会话历史、MCP/IM 渠道配置、OS 登录项（开机自启）。
    resetAll: async () => {
      deleteSettings(SETTING_KEYS);
      // 窗口控件色回落默认主题：键已删，sync 内部对非合法值回落 dark
      syncTitleBarOverlayFromTheme(undefined);
      // 34 号：代理回落 system（CP2 fail 修复项——不收口则分区代理/env 残留，V7）
      await applyProxyChange(undefined);
      logger.info({}, '设置已全部恢复默认（app_settings 设置键已清空）');
      return { settings: {} };
    },

    // 查询 API Key 配置状态：仅返回布尔（P0 安全修复）
    // 明文不回传渲染层（对比 listRuntimeModels 的剥 key 策略，此处对齐），
    // 渲染层只关心"是否已配置"，明文仅主进程内部（llmClient）消费
    // keychainAvailable：safeStorage 不可用时 configured 恒为 false——
    // 「密钥不可读」与「未配置」在调用方视角必须可区分（2026-09-28 深读收口）
    getApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      const apiKey = await getSecret(key);
      return { configured: apiKey !== null, keychainAvailable: isEncryptionAvailable() };
    },

    // 设置 API Key：渲染层传入明文，主进程加密后存储到 keychain
    // safeStorage 不可用时会抛 'safeStorage 加密不可用' 错误，wrap 捕获后返回 INTERNAL_ERROR
    setApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      await setSecret(key, input.apiKey);
      // 缓存重建：provider 工厂按 kind 缓存且闭包持有创建时的 apiKey，
      // llmClient per-model 实例同样持旧 key——不重建则「换 Key 后仍用旧 key
      // 发请求」直到重启（resetAIProvider 的注释一直声称本场景，此前未接线）
      resetAIProvider();
      return { ok: true };
    },

    // 删除 API Key：未设置时也返回 ok=true（幂等）
    deleteApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      await deleteSecret(key);
      // 同上：清除持有已删 key 的缓存实例（下次调用按 keychain 现状重建/报未配置）
      resetAIProvider();
      return { ok: true };
    },

    // 查询遥测级别：同步读取（OTel 初始化也用同一个函数）
    getTelemetryLevel: async () => {
      const level = readTelemetryLevelSync();
      return { level };
    },

    // 设置遥测级别：写入 JSON 文件，需重启应用生效
    setTelemetryLevel: async (input) => {
      await writeTelemetryLevel(input.level); // 生效时机：OTel 于下次启动按此级别决定是否初始化
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
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
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
        // timeoutMs 三态：省略不改 / null 清除 / number 设置（null !== undefined，
        // 条件展开不会误吞清除语义）
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
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
          // null → undefined：DB 可空列（base_url/display_name 未填为 NULL），
          // 渲染层 resSchema 用 .optional() 只放行 undefined——原样返回 null 会
          // 触发契约校验失败 → 前端列表读不到已配置模型（2026-09-04 修复）
          baseUrl: r.baseUrl ?? undefined,
          displayName: r.displayName ?? undefined,
          ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
          isEnabled: r.isEnabled,
          createdAt: r.createdAt,
        })),
      };
    },
  };
}
