// src/main/diagnostics.ts
// 诊断包导出：日志 + 配置 + 版本信息 → 用户选定路径的 zip
// ──────────────────────────────────────────────────────────────
// 背景（对齐 VS Code 等开发者工具的一键排障闭环）：
// - 用户反馈问题时，日志/配置/版本信息散落多处，逐文件拷贝门槛高
// - 本模块一键打包：主进程日志（含轮转 old 文件）+ 用户设置（脱敏）+ 版本清单
//
// 安全设计：
// - 设置脱敏：apiKey/token/secret/password 等敏感键逐层递归替换为 [REDACTED]
// - 仅收集日志文件（*.log），不打包会话 DB / keychain / 备份（体积与隐私双赢）
// - 写盘路径由用户经保存对话框显式选定，主进程不主动落盘
//
// 体积控制：
// - 单个日志 > 8MB 只取尾部 8MB（聚焦"最近发生了什么"，避免打包臃肿）
// - zip 默认 DEFLATE 压缩
// ──────────────────────────────────────────────────────────────

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import AdmZip from 'adm-zip';
import { app } from 'electron';

import { readAllSettings } from './infra/storage/settings-pref';
import { logger } from './utils/logger';

/** 单个日志文件纳入诊断包的最大体积（超出取尾部） */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** 脱敏键匹配：命中即整值替换（明文泄露面收敛到键名本身） */
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|credential|private[_-]?key|access[_-]?key)/i;

/**
 * 值级脱敏模式（2026-09-08 修复：此前只按键名脱敏）
 *
 * 键名匹配覆盖不到「键名无害但值含密钥」的场景（日志行、URL query、
 * Authorization 头文本等）。这里对字符串值再做一次模式替换：
 * - `sk-` / `sk_` 前缀的 OpenAI 系密钥
 * - `Bearer <token>` 形式的授权头
 * - PEM 私钥块起始行
 * - 常见长随机串（32+ 位十六进制/base64，多为 token/密钥）
 */
const VALUE_PATTERNS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-[REDACTED]' },
  { pattern: /(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, replacement: '$1[REDACTED]' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },
  {
    pattern: /\b[A-Fa-f0-9]{32,}\b/g,
    replacement: '[REDACTED]',
  },
];

/** 对字符串做值级脱敏（键名脱敏的补充；纯函数，导出供测试） */
export function redactText(text: string): string {
  let out = text;
  for (const { pattern, replacement } of VALUE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 诊断包导出入参（handler 组装，测试可注入临时目录） */
export interface ExportDiagnosticsOptions {
  /** 目标 zip 路径（用户经保存对话框选定） */
  readonly filePath: string;
  /** 用户数据目录（日志位于其下 logs/） */
  readonly userDataPath: string;
}

/**
 * 递归脱敏：键命中敏感模式时，标量叶子替换为 [REDACTED]；
 * 对象/数组结构节点始终递归（保留 baseUrl/model 等诊断信息，只抹秘密叶子）。
 *
 * 纯函数（导出供单元测试验证脱敏边界）。
 */
export function redactSensitive(value: unknown, key = ''): unknown {
  // 结构节点：不论键是否敏感都下沉递归（数组项沿用父键判定叶子）
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
  // 标量叶子：键命中敏感模式 → 替换；否则做值级脱敏（2026-09-08）
  if (SENSITIVE_KEY_PATTERN.test(key)) {
    return '[REDACTED]';
  }
  return typeof value === 'string' ? redactText(value) : value;
}

/** 版本与环境清单（对齐 app:getInfo 字段，补充导出时间戳） */
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

/**
 * 收集日志目录下全部 *.log 文件
 *
 * 超限（8MB）取尾部片段；单文件读取失败跳过不阻断（日志丢失可容忍）。
 */
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
      // 只保留"最近"日志：超限截尾，避免单日志拖垮诊断包体积
      if (content.byteLength > MAX_LOG_BYTES) {
        content = content.subarray(content.byteLength - MAX_LOG_BYTES);
        logger.info({ file: entry.name }, '诊断导出：日志超限，仅打包尾部 8MB');
      }
      collected.push({ name: entry.name, content });
    } catch (error) {
      // 日志文件被占用/被删属于可容忍失败，跳过继续
      logger.warn({ error: String(error), file: entry.name }, '诊断导出：日志读取失败（跳过）');
    }
  }
  return collected;
}

/**
 * 组装并写入诊断包 zip
 *
 * @param options filePath / userDataPath
 * @throws 读取或写盘失败时抛出（由 IPC wrap 统一错误分类 + Sentry）
 */
export async function exportDiagnosticsPackage(options: ExportDiagnosticsOptions): Promise<void> {
  const { filePath, userDataPath } = options;
  const zip = new AdmZip();

  // 1. 版本与环境清单（manifest.json）
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(buildManifest(userDataPath), null, 2)));

  // 2. 用户设置（脱敏后落盘，防御误导出的密钥泄露）
  let settings: Record<string, unknown> = {};
  try {
    settings = readAllSettings();
  } catch (error) {
    // DB 不可用（未初始化/损坏自愈中）：设置段置空，不阻断诊断包
    logger.warn({ error: String(error) }, '诊断导出：设置读取失败（跳过配置段）');
  }
  zip.addFile(
    'settings.json',
    Buffer.from(JSON.stringify(redactSensitive(settings) as Record<string, unknown>, null, 2)),
  );

  // 3. 主进程日志（含轮转 old 文件）
  // 2026-09-08 修复：日志内容此前原样入包（只按键名脱敏覆盖不到日志行），
  // 现对文本做值级脱敏后再打包。
  const logs = await collectLogFiles(join(userDataPath, 'logs'));
  for (const log of logs) {
    zip.addFile(`logs/${log.name}`, Buffer.from(redactText(log.content.toString('utf8'))));
  }

  // 4. 写盘（用户选定路径；writeZipPromise 异步压缩，避免阻塞主进程）
  await zip.writeZipPromise(filePath);
}
