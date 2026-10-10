// dialog.handler.ts：dialog 域 IPC——目录/文件选择对话框；选中的路径即视为用户授权（入读白名单）
import type { InferHandlers, IPC_DEFINITIONS } from '@code-agent/shared/main';
import { dialog } from 'electron';

import { grantUserReadPaths } from '../infra/file/user-grants';
import type { IpcHandlerContext } from '../utils/wrap';

export const dialogHandlers: InferHandlers<typeof IPC_DEFINITIONS, IpcHandlerContext>['dialog'] = {
  pickDirectory: async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const selectedPath = result.filePaths[0];
    if (selectedPath === undefined) {
      return { canceled: true };
    }

    return { canceled: false, path: selectedPath };
  },

  pickFiles: async (input) => {
    const result = await dialog.showOpenDialog({
      properties: input.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    // 用户经系统对话框主动选中的文件自动加入读白名单（path-guard 的 user-grants 机制：
    // 用户亲自选择 = 授权，Agent 后续可直接读，不再重复弹审批）
    grantUserReadPaths(result.filePaths);

    return { canceled: false, paths: result.filePaths };
  },
};
