import { join } from 'node:path';
import type { InferHandlers } from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  type IPC_DEFINITIONS,
  IPC_PROTOCOL_VERSION,
} from '@code-agent/shared/main';
import { app, dialog, shell } from 'electron';

import { exportDiagnosticsPackage } from '../diagnostics';
import {
  createAutostartDeps,
  readAutostartState,
  setAutostartEnabled,
} from '../infra/autostart/autostart';
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

interface BuildInfo {
  readonly version?: string;
  readonly channel?: string;
  readonly commitSha?: string;
  readonly buildTime?: string;
}

function readBuildInfo(): BuildInfo {
  try {
    const candidates = app.isPackaged
      ? [join(process.resourcesPath, 'build-info.json')]
      : [join(app.getAppPath(), 'resources', 'build-info.json')];
    for (const file of candidates) {
      const data = require('node:fs').readFileSync(file, 'utf-8');
      const parsed = JSON.parse(data) as BuildInfo;
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed;
      }
    }
  } catch {}
  return { channel: 'dev' };
}

export const appHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['app'] = {
  getStatus: async () => {
    return { ready: true, protocolVersion: IPC_PROTOCOL_VERSION };
  },

  getInfo: async () => {
    const build = readBuildInfo();
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
      ...(build.channel !== undefined ? { channel: build.channel } : {}),
      ...(build.buildTime !== undefined ? { buildTime: build.buildTime } : {}),
      ...(build.commitSha !== undefined ? { commitSha: build.commitSha } : {}),
    };
  },

  openExternal: async (input) => {
    if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
      throw new AppError(ErrorCode.INVALID_INPUT, '仅允许 http/https 协议');
    }
    await shell.openExternal(input.url);
    return { ok: true };
  },

  openDataDir: async () => {
    const dir = app.getPath('userData');
    const error = await shell.openPath(dir);
    return { ok: error.length === 0 };
  },

  getLoginItemSettings: async () => {
    return await readAutostartState(createAutostartDeps());
  },

  setLoginItemSettings: async (input) => {
    return await setAutostartEnabled(createAutostartDeps(), input.openAtLogin);
  },

  quit: async () => {
    app.quit();
    return { ok: true };
  },

  exportDiagnostics: async () => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const { canceled, filePath } = await dialog.showSaveDialog({
      title: '导出诊断包',
      defaultPath: join(app.getPath('documents'), `diagnostics-${stamp}.zip`),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
    });
    if (canceled || filePath === undefined || filePath === '') {
      return { saved: false };
    }
    try {
      const autostart = await readAutostartState(createAutostartDeps()).catch(() => null);
      await exportDiagnosticsPackage({
        filePath,
        userDataPath: app.getPath('userData'),
        autostart,
      });
      logger.info({ filePath, autostart }, '诊断包导出完成');
      return { saved: true, path: filePath };
    } catch (error) {
      logger.error({ error: String(error), filePath }, '诊断包导出失败');
      throw error;
    }
  },
};
