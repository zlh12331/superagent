// app.handler.ts：app 域 IPC——就绪状态/构建信息/外链打开/数据目录/开机自启/退出/诊断包导出
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

// 构建信息从打包时注入的 build-info.json 读（CI 产物）；读不到按 dev 兜底
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
    // 协议白名单：shell.openExternal 对 file:/自定 scheme 会被系统关联程序处理，只放行 http/https
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

  // 诊断包：保存对话框选落点 → 打 zip（导出器在 ../diagnostics，内部已做敏感信息脱敏）
  exportDiagnostics: async () => {
    // 文件名时间戳剔除 :/（Windows 文件名非法字符）
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
