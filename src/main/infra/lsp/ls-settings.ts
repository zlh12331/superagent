// ls-settings.ts：LSP 用户覆盖读取（settings 表 lsp.serverCommands 键）——
// 每语言一条命令行字符串；损坏整体回退内置默认
import { logger } from '../../utils/logger';
import { readAllSettings } from '../storage/settings-pref';
import { type LsServerSpec, parseServerCommand, SUPPORTED_LS_LANGUAGES } from './ls-config';

/** 读各语言服务器覆盖（仅认可语言键；值非法跳过该语言） */
export function readLsServerOverrides(): Record<string, LsServerSpec> {
  const overrides: Record<string, LsServerSpec> = {};
  try {
    const raw = readAllSettings()['lsp'] as { serverCommands?: unknown } | undefined;
    const commands = (raw?.serverCommands ?? {}) as Record<string, unknown>;
    for (const language of SUPPORTED_LS_LANGUAGES) {
      const value = commands[language];
      if (typeof value !== 'string') {
        continue;
      }
      const spec = parseServerCommand(value);
      if (spec !== undefined) {
        overrides[language] = spec;
      }
    }
  } catch (err: unknown) {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'LSP 服务器用户配置读取失败，回退内置默认',
    );
  }
  return overrides;
}
