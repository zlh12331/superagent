// system.handler.ts：system 域（进程状态快照）+ logs 域（日志尾部读取，日志面板消费）
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { app } from 'electron';

import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

// 日志尾部默认 200 行，硬上限 2000（主进程日志面板拉全量会把日志文件整个读进内存）
const DEFAULT_LINES = 200;
const MAX_LINES = 2000;

/** 进程状态快照：版本/平台/运行时长/内存/CPU（诊断与设置关于页消费） */
export const systemHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['system'] = {
  getStatus: async () => {
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
  },
};

/** 日志尾部读取：可按级别过滤；文件缺失/读取失败返回空集不抛（日志面板不允许炸） */
export const logsHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['logs'] = {
  read: async (input) => {
    const requestedLines = input?.lines ?? DEFAULT_LINES;
    const lines = Math.min(requestedLines, MAX_LINES);
    const logPath = join(app.getPath('logs'), 'main.log');

    try {
      const allLines = await readTailLines(logPath, lines);
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
      return {
        lines: [],
        total: 0,
        filePath: logPath,
        truncated: false,
      };
    }
  },
};

// 尾部读取从文件末尾按 4KB 块倒着找换行符，凑够行数即止——日志文件可能数十 MB，
// 全量读再 slice 会白读一大截
async function readTailLines(filePath: string, lines: number): Promise<string[]> {
  const file = await open(filePath, 'r');
  try {
    const stat = await file.stat();
    const fileSize = stat.size;
    if (fileSize === 0) {
      return [];
    }

    const blockSize = 4 * 1024;
    const chunks: Buffer[] = [];
    let position = fileSize;
    let newlineCount = 0;

    while (position > 0 && newlineCount < lines) {
      const readSize = Math.min(blockSize, position);
      position -= readSize;
      const buffer = Buffer.alloc(readSize);
      await file.read(buffer, 0, readSize, position);
      chunks.unshift(buffer);
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
    const nonEmpty = allLines.filter((line) => line.length > 0);
    return nonEmpty.slice(-lines);
  } finally {
    try {
      await file.close();
    } catch (closeError) {
      logger.warn({ error: closeError, filePath }, '关闭日志文件句柄失败');
    }
  }
}
