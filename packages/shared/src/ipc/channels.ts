import { deriveChannels } from './derive';
import { IPC_META } from './meta';

/**
 * IPC Channel 常量表（自动生成）
 *
 * 字符串值即协议契约，所有 ipcMain.handle / ipcRenderer.on / webContents.send 必须使用此表的字段，
 * 严禁裸字符串，避免拼写错误导致运行时找不到 handler。
 */
export const IPC_CHANNELS = deriveChannels(IPC_META);

/** IPC Channel 字面量联合类型 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
