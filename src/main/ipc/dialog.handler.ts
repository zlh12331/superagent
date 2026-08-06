// src/main/ipc/dialog.handler.ts
// Dialog 域 IPC handler：原生对话框封装（定义表驱动）
//
// 职责：
// - dialog:pickDirectory：调用 Electron dialog.showOpenDialog 弹原生目录选择器
// - dialog:pickFiles：弹原生文件选择器（多选）
// - 返回标准化结果 { canceled, path? } / { canceled, paths? }
//
// 设计：
// - 无 ServiceContainer 依赖（dialog 是 Electron 全局 API，无状态）
// - properties 固定为目录选择（directory + 单选）

import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { dialog } from 'electron';

import type { IpcHandlerContext } from '../utils/wrap';

/** Dialog 域 handler 实现 */
export const dialogHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['dialog'] = {
  // dialog:pickDirectory - 弹原生目录选择器（单选目录）
  pickDirectory: async () => {
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

  // dialog:pickFiles - 弹原生文件选择器（多选，任意文件类型）
  // 用于聊天输入框附件选择（对齐参考项目 ChatInputAttachments）
  pickFiles: async (input) => {
    const result = await dialog.showOpenDialog({
      properties: input.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    return { canceled: false, paths: result.filePaths };
  },
};
