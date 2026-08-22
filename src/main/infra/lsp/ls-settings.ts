// src/main/infra/lsp/ls-settings.ts
// 语言服务器用户配置读取：app_settings 的 lsp.serverCommands → 结构化覆盖表
// ──────────────────────────────────────────────────────────────
// 数据流：渲染层设置页（workspace pane）写穿透 settings:set('lsp', {...})
// → SQLite app_settings 表 → 本模块在 ServiceContainer 构造 manager 时读取。
// 仅收录受支持语言键；非法/空命令行忽略；DB 异常降级为空覆盖（内置默认兜底）。
// ──────────────────────────────────────────────────────────────

import { logger } from '../../utils/logger';
import { readAllSettings } from '../storage/settings-pref';
import { type LsServerSpec, parseServerCommand, SUPPORTED_LS_LANGUAGES } from './ls-config';

/**
 * 读取按语言的 LSP 服务器覆盖（无配置/异常时返回空对象 = 全部走内置默认）
 */
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
