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
import { syncTitleBarOverlayFromTheme } from '../window-theme';

export function createSettingsHandlers(params: {
  permissionService: IPermissionService;
}): InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['settings'] {
  const { permissionService } = params;
  return {
    getAll: async () => {
      const settings = readAllSettings();
      syncTitleBarOverlayFromTheme(settings['theme']);
      return { settings };
    },

    set: async (input) => {
      writeSetting(input.key, input.value);
      if (input.key === 'theme') {
        syncTitleBarOverlayFromTheme(input.value);
      }
      if (input.key === 'language') {
        setMainLanguage(input.value);
      }
      if (input.key === 'proxy') {
        await applyProxyChange(input.value);
      }
      return { ok: true };
    },

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
        if (key === 'theme') {
          syncTitleBarOverlayFromTheme(value);
        }
        if (key === 'proxy') {
          await applyProxyChange(value);
        }
        broadcastSettingChanged(key, value);
      }
      return { imported: outcome.imported, skipped: outcome.skipped };
    },

    resetAll: async () => {
      deleteSettings(SETTING_KEYS);
      syncTitleBarOverlayFromTheme(undefined);
      await applyProxyChange(undefined);
      logger.info({}, '设置已全部恢复默认（app_settings 设置键已清空）');
      return { settings: {} };
    },

    getApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      const apiKey = await getSecret(key);
      return { configured: apiKey !== null, keychainAvailable: isEncryptionAvailable() };
    },

    setApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      await setSecret(key, input.apiKey);
      resetAIProvider();
      return { ok: true };
    },

    deleteApiKey: async (input) => {
      const key = toKeychainKey(input.provider);
      await deleteSecret(key);
      resetAIProvider();
      return { ok: true };
    },

    getTelemetryLevel: async () => {
      const level = readTelemetryLevelSync();
      return { level };
    },

    setTelemetryLevel: async (input) => {
      await writeTelemetryLevel(input.level);
      return { ok: true, level: input.level };
    },

    getApprovalMode: async () => {
      const mode = readApprovalModeSync();
      return { mode };
    },

    setApprovalMode: async (input) => {
      await writeApprovalMode(input.mode);
      permissionService.setApprovalMode(input.mode);
      return { ok: true, mode: input.mode };
    },

    addRuntimeModel: async (input) => {
      await runtimeModelStore.add({
        modelId: input.modelId,
        providerKind: input.providerKind,
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
      });
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    updateRuntimeModel: async (input) => {
      await runtimeModelStore.update({
        modelId: input.modelId,
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
        ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
        ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        ...(input.apiFormat !== undefined ? { apiFormat: input.apiFormat } : {}),
        ...(input.isEnabled !== undefined ? { isEnabled: input.isEnabled } : {}),
      });
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    removeRuntimeModel: async (input) => {
      await runtimeModelStore.remove(input.modelId);
      llmClient.invalidateModel(input.modelId);
      return { ok: true };
    },

    listRuntimeModels: async () => {
      const records = await runtimeModelStore.list();
      return {
        models: records.map((r) => ({
          modelId: r.modelId,
          providerKind: r.providerKind,
          baseUrl: r.baseUrl ?? undefined,
          displayName: r.displayName ?? undefined,
          ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
          ...(r.apiFormat !== undefined ? { apiFormat: r.apiFormat } : {}),
          isEnabled: r.isEnabled,
          createdAt: r.createdAt,
        })),
      };
    },
  };
}
