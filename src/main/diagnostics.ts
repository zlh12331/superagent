// diagnostics.ts：诊断包导出——manifest + 脱敏后设置 + 脱敏日志 + 运行时状态打 zip，
// 供 GitHub Issue 报障附件（本地优先，不上传任何服务）
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { app } from 'electron';

import { readAllSettings } from './infra/storage/settings-pref';
import { logger } from './utils/logger';

// 单个日志文件超过 8MB 只保留尾部——近期上下文在尾部，同时防诊断包爆炸
const MAX_LOG_BYTES = 8 * 1024 * 1024;

// 键名形态兜底：设置键命中即整体 [REDACTED]（不看值）
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|access[_-]?key)/i;

// 值形态兜底：键名不含敏感词但值本身是密钥形态（日志正文里的 key 串、Bearer 头、PEM 头、32+ 位 hex）
const VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-[REDACTED]' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: '$1[REDACTED]' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },
  {
    pattern: /\b[A-Fa-f0-9]{32,}\b/g,
    replacement: '[REDACTED]',
  },
];

/** 对任意文本跑值形态脱敏（日志正文用——日志行没有键名上下文，只能按形态匹配） */
export function redactText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 导出选项：zip 落盘路径 + userData 根（取日志/窗口状态）+ 自启状态快照（由调用方装配传入） */
export interface ExportDiagnosticsOptions {
  readonly filePath: string;
  readonly userDataPath: string;
  readonly autostart?: unknown;
}

/**
 * 递归脱敏任意结构：对象/数组深入遍历，键名命中即整值 [REDACTED]，
 * 字符串叶子再过一遍值形态（双层：键名层 + 值形态层）
 */
export function redactSensitive(value: unknown, key = ''): unknown {
  if (value !== null && typeof value === 'object') {
    if (Array.isArray(value)) {
      return value.map((item) => redactSensitive(item, key));
    }
    const result: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = redactSensitive(childValue, childKey);
    }
    return result;
  }
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  return typeof value === 'string' ? redactText(value) : value;
}

function buildManifest(userDataPath: string): Record<string, unknown> {
  return {
    app: app.getName(),
    appVersion: app.getVersion(),
    versions: {
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
    },
    platform: process.platform,
    arch: process.arch,
    userDataPath,
    exportedAt: new Date().toISOString(),
  };
}

async function collectLogFiles(logsDir: string): Promise<Array<{ name: string; content: Buffer }>> {
  const entries = await readdir(logsDir, { withFileTypes: true }).catch((error) => {
    logger.warn({ error: String(error), logsDir }, '诊断导出：日志目录读取失败（跳过日志）');
    return [];
  });

  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.log'));
  const collected: Array<{ name: string; content: Buffer }> = [];

  for (const entry of files) {
    const filePath = join(logsDir, entry.name);
    try {
      let content = await readFile(filePath);
      if (content.byteLength > MAX_LOG_BYTES) {
        content = content.subarray(content.byteLength - MAX_LOG_BYTES);
        logger.info({ file: entry.name }, '诊断导出：日志超限，仅打包尾部 8MB');
      }
      collected.push({ name: entry.name, content });
    } catch (error) {
      logger.warn({ error: String(error), file: entry.name }, '诊断导出：日志读取失败（跳过）');
    }
  }
  return collected;
}

/**
 * 导出诊断包 zip：manifest.json → settings.json（脱敏）→ logs/*.log（脱敏，单文件超限取尾部）→
 * runtime.json（自启 + 窗口状态）
 *
 * 各环节失败都降级跳过（warn 后继续），保证包总是能产出
 */
export async function exportDiagnosticsPackage(options: ExportDiagnosticsOptions): Promise<void> {
  const { filePath, userDataPath, autostart } = options;
  const zip = new AdmZip();

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(buildManifest(userDataPath), null, 2)));

  let settings: Record<string, unknown> = {};
  try {
    settings = readAllSettings();
  } catch (error) {
    logger.warn({ error: String(error) }, '诊断导出：设置读取失败（跳过配置段）');
  }
  zip.addFile(
    'settings.json',
    Buffer.from(JSON.stringify(redactSensitive(settings) as Record<string, unknown>, null, 2)),
  );

  const logs = await collectLogFiles(join(userDataPath, 'logs'));
  for (const log of logs) {
    zip.addFile(`logs/${log.name}`, Buffer.from(redactText(log.content.toString('utf8'))));
  }

  zip.addFile(
    'runtime.json',
    Buffer.from(
      JSON.stringify(
        { autostart: autostart ?? null, windowState: await readWindowState(userDataPath) },
        null,
        2,
      ),
    ),
  );

  await zip.writeZipPromise(filePath);
}

async function readWindowState(userDataPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(userDataPath, 'window-state.json'), 'utf8'));
  } catch {
    return null;
  }
}
