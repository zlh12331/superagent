// src/main/ipc/dialog.handler.ts
// Dialog 域 IPC handler：原生对话框封装
// ──────────────────────────────────────────────────────────────
// 职责：
// - 注册 dialog:pickDirectory channel
// - 调用 Electron dialog.showOpenDialog 弹原生目录选择器
// - 返回标准化结果 { canceled, path? }
//
// 设计：
// - 无 ServiceContainer 依赖（dialog 是 Electron 全局 API，无状态）
// - properties 固定为目录选择（directory + 单选）
// ──────────────────────────────────────────────────────────────

import {
  type DialogPickDirectoryReq,
  DialogPickDirectoryReqSchema,
  type DialogPickDirectoryRes,
  IPC_CHANNELS,
} from '@code-agent/shared/main';
import { dialog } from 'electron';
import { wrap } from '../utils/wrap';

/**
 * 注册 Dialog 域 IPC handler
 *
 * 当前仅支持目录选择器（pickDirectory）。
 * properties 固定为 { properties: ['openDirectory'] }，单选目录。
 */
export function registerDialogHandlers(): void {
  // dialog:pickDirectory - 弹原生目录选择器
  wrap<DialogPickDirectoryReq, DialogPickDirectoryRes>(
    IPC_CHANNELS.DIALOG_PICK_DIRECTORY,
    DialogPickDirectoryReqSchema,
    async () => {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
      });

      // 兜底：canceled=true 或 filePaths 为空时视为取消
      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true };
      }

      // 取第一个选中路径（单选模式只会有一个）
      // 显式提取 + undefined 守卫：满足 noUncheckedIndexedAccess + exactOptionalPropertyTypes
      const selectedPath = result.filePaths[0];
      if (selectedPath === undefined) {
        return { canceled: true };
      }

      return { canceled: false, path: selectedPath };
    },
  );
}
