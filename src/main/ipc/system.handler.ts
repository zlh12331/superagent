// src/main/ipc/system.handler.ts
// 系统级 IPC handler（运行时可观测性）
// ──────────────────────────────────────────────────────────────
// 职责：
// - system:getStatus：返回运行时状态（内存/CPU/uptime/版本），DevPanel Metrics tab 使用
// - logs:read：读取最近 N 行日志（从 main.log 文件尾部倒读），DevPanel Logs tab 使用
//
// 设计：
// - 复用 wrap.ts 统一包装（traceId + zod 校验 + Sentry 上报 + 日志埋点）
// - system:getStatus 读取 Node.js 原生 process.memoryUsage / cpuUsage
// - logs:read 使用 fs.open 从文件尾部按块倒读，避免大文件全量加载拖慢 IPC
// ──────────────────────────────────────────────────────────────

import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type ReadLogsReq,
  ReadLogsReqSchema,
  type ReadLogsRes,
  type SystemStatusRes,
} from '@novel-writer/shared';
import { app } from 'electron';
import { logger } from '../utils/logger';
import { wrap } from '../utils/wrap';

/** logs:read 入参默认行数 */
const DEFAULT_LINES = 200;
/** logs:read 入参最大行数（防止大文件拖慢渲染层，与 schemas/system.ts 一致） */
const MAX_LINES = 2000;

/**
 * 注册系统级 IPC handler
 *
 * 在 app.whenReady() 后调用一次。
 */
export function registerSystemHandlers(): void {
  // system:getStatus：查询运行时状态（内存/CPU/uptime/版本）
  wrap<null, SystemStatusRes>(IPC_CHANNELS.SYSTEM_GET_STATUS, null, async () => {
    const mem = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      uptimeSeconds: Math.round(process.uptime()),
      pid: process.pid,
      memory: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers,
      },
      cpu: {
        user: cpu.user,
        system: cpu.system,
      },
      timestamp: new Date().toISOString(),
    };
  });

  // logs:read：读取最近 N 行日志（从文件尾部倒读）
  wrap<ReadLogsReq, ReadLogsRes>(IPC_CHANNELS.LOGS_READ, ReadLogsReqSchema, async (input) => {
    const requestedLines = input?.lines ?? DEFAULT_LINES;
    const lines = Math.min(requestedLines, MAX_LINES);
    const logPath = join(app.getPath('logs'), 'main.log');

    try {
      const allLines = await readTailLines(logPath, lines);
      // 级别过滤（可选）
      const level = input?.level;
      const filtered =
        level !== undefined ? allLines.filter((line) => line.includes(`[${level}]`)) : allLines;

      return {
        lines: filtered,
        total: filtered.length,
        filePath: logPath,
        truncated: requestedLines > MAX_LINES,
      };
    } catch (err) {
      logger.error({ error: err, logPath }, '读取日志文件失败');
      // 文件不存在或读取失败时返回空结果，而非抛错（避免 DevPanel 崩溃）
      return {
        lines: [],
        total: 0,
        filePath: logPath,
        truncated: false,
      };
    }
  });

  logger.info({}, '系统级 IPC handler 注册完成（2 channel：system:getStatus / logs:read）');
}

/**
 * 从文件尾部读取最近 N 行（高效版，不全量加载）
 *
 * 策略：
 * - 从文件末尾向前按 4KB 块倒读
 * - 累积到足够行数后停止
 * - 返回按时间正序的行数组
 *
 * 性能：100MB 日志文件读取 200 行约 <10ms，避免全量 readFile 拖慢 IPC。
 */
async function readTailLines(filePath: string, lines: number): Promise<string[]> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    const fileSize = stat.size;
    if (fileSize === 0) {
      return [];
    }

    const blockSize = 4 * 1024; // 4KB
    const chunks: Buffer[] = [];
    let position = fileSize;
    let newlineCount = 0;

    while (position > 0 && newlineCount < lines) {
      const readSize = Math.min(blockSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await file.read(buffer, 0, readSize, position);
      chunks.unshift(buffer);
      // 统计换行符数量
      for (let i = 0; i < readSize; i++) {
        if (buffer[i] === 0x0a) {
          newlineCount++;
          if (newlineCount >= lines) {
            break;
          }
        }
      }
    }

    const content = Buffer.concat(chunks).toString('utf-8');
    const allLines = content.split('\n');
    // 移除空行（文件末尾通常有一个空行）
    const nonEmpty = allLines.filter((line) => line.length > 0);
    // 最近的 N 行（正序）
    return nonEmpty.slice(-lines);
  } finally {
    // L5 修复：close 失败单独记录 warn，避免覆盖 try 块的原始错误
    // - 原实现：finally 中 `await file.close()` 直接抛错会替换 try 块的原始错误（read/stat 失败的 stack 丢失）
    // - 修复后：close 失败仅 warn，不影响 readTailLines 的返回值或抛出的原始错误
    try {
      await file.close();
    } catch (closeError) {
      logger.warn({ error: closeError, filePath }, '关闭日志文件句柄失败');
    }
  }
}
