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

    grantUserReadPaths(result.filePaths);

    return { canceled: false, paths: result.filePaths };
  },
};
