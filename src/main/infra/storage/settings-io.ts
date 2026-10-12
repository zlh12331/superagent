import type { SettingKey, SettingsExportFile } from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  SETTING_KEYS,
  SETTINGS_EXPORT_VERSION,
  SettingsExportFileSchema,
} from '@code-agent/shared/main';
import { logger } from '../../utils/logger';
import { readAllSettings, writeSettings } from './settings-pref';

export interface AppliedSetting {
  readonly key: SettingKey;
  readonly value: unknown;
}

export interface SettingsImportOutcome {
  readonly imported: number;
  readonly skipped: number;
  readonly applied: readonly AppliedSetting[];
}

export function buildSettingsExportFile(): SettingsExportFile {
  return {
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: Date.now(),
    settings: readAllSettings(),
  };
}

export function applySettingsImport(payload: unknown): SettingsImportOutcome {
  const parsed = SettingsExportFileSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `设置文件格式校验失败（仅支持 version=${SETTINGS_EXPORT_VERSION} 导出格式）`,
      parsed.error,
    );
  }
  const whitelist = new Set<string>(SETTING_KEYS);
  const applied: AppliedSetting[] = [];
  let skipped = 0;
  for (const [key, value] of Object.entries(parsed.data.settings)) {
    if (!whitelist.has(key)) {
      skipped += 1;
      continue;
    }
    applied.push({ key: key as SettingKey, value });
  }
  writeSettings(applied);
  logger.info({ imported: applied.length, skipped }, '设置导入完成（白名单外键跳过）');
  return { imported: applied.length, skipped, applied };
}
