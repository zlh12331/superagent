// packages/shared/src/ipc/channels.ts
// IPC Channel 字符串常量（从 IPC_META 自动推导）
// 设计文档 §5.2 命名规范 + §5.3 完整清单
//
// 命名规范：
//   {domain}:{action}        请求-响应（ipcMain.handle）
//   {domain}:stream:{event}  流式事件（webContents.send）
//   {domain}:event:{name}    状态变更事件（webContents.send）
//
// 本文件不再手写常量：IPC_CHANNELS 由 deriveChannels(IPC_META) 生成，
// meta 为 channel 真源（definitions 在 meta 之上追加 zod schema 与类型标记），
// 新增/修改 IPC 方法只需编辑 meta.ts/definitions.ts，通道常量自动同步。
// 使用 as const 派生字面量类型，防止 ipcMain.handle / ipcRenderer.on 拼写错误
//
// 当前包含 23 个域（Code Agent 架构）。完整清单以 meta.ts 为唯一真源，以下仅为示例：
// - 应用级：app:getStatus / app:openExternal
// - Agent 域（Code Agent 核心）：agent:run / agent:stop / agent:stream:* / agent:tool:* / agent:approval:*
// - 会话域：session:list / session:get / session:delete / session:rename
// - 文件域：file:read / file:write / file:list / file:watch:* / file:event
// - 搜索域：search:grep / search:glob
// - 终端域：terminal:create / input / resize / kill / event:*
// - Git 域：git:status / diff / add / commit / push
// - 代码库域：codebase:query / explore / node / callers / callees / impact

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
