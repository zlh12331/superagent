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
 * - 常见长随机串（32+ 位十六进制，多为 token/密钥）
 *
 * 有意不覆盖 base64：日志里长 base64 与图片/二进制片段无法区分，
 * 误伤会把诊断包正文打成不可读的 [REDACTED] 海洋——宁缺勿滥。
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
  /**
   * 开机自启状态（由调用方读好传入）
   *
   * 为什么由调用方传入而非本模块自行读取：autostart 依赖 Electron `app` 与平台环境，
   * 在诊断模块内直接调会引入对 `app` 桩的额外耦合（本模块的测试用极简 app mock）。
   * 这两项是「开机自启/静默启动」类报障的关键判据（见 30-spec §3 P2-2）。
   */
  readonly autostart?: unknown;
}

/**
 * 递归脱敏：键命中敏感模式时，标量叶子替换为 [REDACTED]；
 * 对象/数组结构节点始终递归（保留 baseUrl/model 等诊断信息，只抹秘密叶子）。
 *
 * 纯函数（导出供单元测试验证脱敏边界）。
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
 * 组装并写入诊断包 zip
 *
 * @param options filePath / userDataPath
 * @throws 读取或写盘失败时抛出（由 IPC wrap 统一错误分类 + 本地日志）
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

/** 读取窗口状态文件（诊断用；不存在/损坏返回 null，不阻断导出） */
async function readWindowState(userDataPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(userDataPath, 'window-state.json'), 'utf8'));
  } catch {
    return null;
  }
}
