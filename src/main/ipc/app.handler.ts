// src/main/ipc/app.handler.ts
// 应用级 IPC handler（定义表驱动，注册由 registerIpcHandlers 统一执行）
//
// 当前仅实现 2 个应用级 channel：
// - app:getStatus：返回应用就绪状态（health check）
// - app:openExternal：通过系统浏览器打开外链
//
// 说明：handler 对象形状受 InferHandlers 约束（缺方法编译期报错）；
// channel / schema 由 IPC_DEFINITIONS 提供，本文件只写业务实现。

import type { InferHandlers } from '@code-agent/shared/main';
import {
  AppError,
  ErrorCode,
  type IPC_DEFINITIONS,
  IPC_PROTOCOL_VERSION,
} from '@code-agent/shared/main';
import { app, shell } from 'electron';

import type { IpcHandlerContext } from '../utils/wrap';

/** 应用级 handler 实现（app 域） */
export const appHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['app'] = {
  // 应用状态查询：返回就绪标记 + IPC 协议版本（渲染层启动校验，防版本错配）
  getStatus: async () => {
    return { ready: true, protocolVersion: IPC_PROTOCOL_VERSION };
  },

  // 应用信息查询：版本与环境信息（「关于」面板数据源）
  getInfo: async () => {
    return {
      version: app.getVersion(),
      electron: process.versions.electron ?? 'unknown',
      node: process.versions.node ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath('userData'),
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
};
