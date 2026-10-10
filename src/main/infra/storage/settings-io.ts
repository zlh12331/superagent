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

/** 实际写入的键值对（handler 据此广播 settings:event:changed 刷新渲染层 store） */
export interface AppliedSetting {
  readonly key: SettingKey;
  readonly value: unknown;
}

/** 设置导入结果（imported/skipped 供响应与 UI 提示；applied 供广播） */
export interface SettingsImportOutcome {
  readonly imported: number;
  readonly skipped: number;
  readonly applied: readonly AppliedSetting[];
}

/**
 * 组装设置导出文件（app_settings 全表 JSON，version=1）
 *
 * 全表导出：白名单外的历史残留键也导出（导出保真）；导入侧再按白名单过滤。
 */
export function buildSettingsExportFile(): SettingsExportFile {
  return {
    version: SETTINGS_EXPORT_VERSION,
    exportedAt: Date.now(),
    settings: readAllSettings(),
  };
}

/**
 * 应用设置导入（只接受 version=1 导出文件格式）
 *
 * 流程：zod 校验 → 逐键过 SETTING_KEYS 白名单 → 白名单内的键单事务写入。
 *
 * @throws AppError(INVALID_INPUT) 文件格式校验失败（版本不匹配 / 字段缺失 / 非对象）
 * @throws Error 白名单内任一 value 非法（writeSettings 事务整体回滚）
 */
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
