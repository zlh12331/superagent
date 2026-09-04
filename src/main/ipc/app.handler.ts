// src/main/ipc/app.handler.ts
// 应用级 IPC handler（定义表驱动，注册由 registerIpcHandlers 统一执行）
//
// 当前仅实现 2 个应用级 channel：
// - app:getStatus：返回应用就绪状态（health check）
// - app:openExternal：通过系统浏览器打开外链
//
// 说明：handler 对象形状受 InferHandlers 约束（缺方法编译期报错）；
// channel / schema 由 IPC_DEFINITIONS 提供，本文件只写业务实现。

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
import { logger } from '../utils/logger';
import type { IpcHandlerContext } from '../utils/wrap';

/**
 * 构建信息（由 scripts/generate-build-info.mjs 在发布构建时写入 resources/build-info.json；
 * dev 直跑不生成 → channel 兜底 'dev'）
 */
interface BuildInfo {
  readonly version?: string;
  readonly channel?: string;
  readonly commitSha?: string;
  readonly buildTime?: string;
}

/** 读取构建信息：优先打包资源（process.resourcesPath），dev 回退项目根 resources */
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
  } catch {
    // 文件缺失/损坏：非阻塞，回退 dev 标记
  }
  return { channel: 'dev' };
}

/** 应用级 handler 实现（app 域） */
export const appHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['app'] = {
  // 应用状态查询：返回就绪标记 + IPC 协议版本（渲染层启动校验，防版本错配）
  getStatus: async () => {
    return { ready: true, protocolVersion: IPC_PROTOCOL_VERSION };
  },

  // 应用信息查询：版本与环境信息（「关于」面板数据源）
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

  // 外链打开：仅允许 http/https 协议，防止 file:// / javascript: 等危险协议
  openExternal: async (input) => {
    if (!input.url.startsWith('http://') && !input.url.startsWith('https://')) {
      throw new AppError(ErrorCode.INVALID_INPUT, '仅允许 http/https 协议');
    }
    await shell.openExternal(input.url);
    return { ok: true };
  },

  // 打开用户数据目录（会话/备份/日志所在，数据资产可迁移入口）
  openDataDir: async () => {
    const dir = app.getPath('userData');
    const error = await shell.openPath(dir);
    return { ok: error.length === 0 };
  },

  // 诊断包导出：日志 + 设置（脱敏）+ 版本清单 → 用户选定路径的 zip（取消时 saved=false）
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
      await exportDiagnosticsPackage({ filePath, userDataPath: app.getPath('userData') });
      logger.info({ filePath }, '诊断包导出完成');
      return { saved: true, path: filePath };
    } catch (error) {
      logger.error({ error: String(error), filePath }, '诊断包导出失败');
      throw error;
    }
  },
};
