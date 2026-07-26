// src/main/ipc/devtools.handler.ts
// DevTools 域 IPC handler（开发者工具集成）
// ──────────────────────────────────────────────────────────────
// 职责：
// - devtools:open：打开 Chromium DevTools，支持 mode 参数（detach/right/bottom）
//
// 设计：
// - 复用 wrap.ts 统一包装（traceId + zod 校验 + Sentry 上报 + 日志埋点）
// - 通过 BrowserWindow.fromWebContents(ctx.sender) 找到调用方窗口
// - 调用 webContents.openDevTools({ mode }) 打开 DevTools
// - 已打开时重复调用会聚焦原 DevTools 窗口（Electron 原生行为）
//
// 集成位置：
// - 在 app.whenReady() 后由 index.ts 调用 registerDevToolsHandlers()
// - 渲染层 InspectorPanel 按钮触发 window.api.devtools.open({ mode: 'detach' })
// ──────────────────────────────────────────────────────────────

import {
  IPC_CHANNELS,
  type OpenDevToolsReq,
  OpenDevToolsReqSchema,
  type OpenDevToolsRes,
} from '@novel-writer/shared';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';
import { wrap } from '../utils/wrap';

/** devtools:open 默认 mode（独立窗口，不占用应用主窗口空间） */
const DEFAULT_MODE: 'detach' | 'right' | 'bottom' = 'detach';

/**
 * 注册 DevTools 域 IPC handler
 *
 * 在 app.whenReady() 后调用一次。
 */
export function registerDevToolsHandlers(): void {
  // devtools:open：打开 Chromium DevTools
  wrap<OpenDevToolsReq, OpenDevToolsRes>(
    IPC_CHANNELS.DEVTOOLS_OPEN,
    OpenDevToolsReqSchema,
    async (input, ctx) => {
      const mode = input?.mode ?? DEFAULT_MODE;
      const win = BrowserWindow.fromWebContents(ctx.sender);

      if (win === null) {
        logger.warn({ traceId: ctx.traceId }, 'DevTools 打开失败：sender 窗口不存在');
        return { ok: false, mode };
      }

      // Electron API：webContents.openDevTools({ mode })
      // mode 取值：'left' | 'right' | 'bottom' | 'undocked' | 'detach'
      // 本项目仅暴露 'detach' | 'right' | 'bottom'（schema 已限制）
      win.webContents.openDevTools({ mode });
      logger.info({ traceId: ctx.traceId, mode }, 'DevTools 已打开');

      return { ok: true, mode };
    },
  );

  logger.info({}, 'DevTools IPC handler 注册完成（1 channel：devtools:open）');
}
