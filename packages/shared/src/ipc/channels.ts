// packages/shared/src/ipc/channels.ts
// IPC Channel 字符串常量
// 设计文档 §5.2 命名规范 + §5.3 完整清单
//
// 命名规范：
//   {domain}:{action}        请求-响应（ipcMain.handle）
//   {domain}:stream:{event}  流式事件（webContents.send）
//   {domain}:event:{name}    状态变更事件（webContents.send）
//
// 使用 as const 派生字面量类型，防止 ipcMain.handle / ipcRenderer.on 拼写错误
//
// 说明：业务相关 channel（project/chapter/character/worldview/chat/rag/agent/settings）
// 已随业务层一并删除，仅保留应用级 channel 作为 Electron 模板基础设施。

/**
 * IPC Channel 常量表
 *
 * 当前仅包含应用级 channel：
 * - APP_GET_STATUS：获取应用运行状态（health check）
 * - APP_OPEN_EXTERNAL：通过系统浏览器打开外链
 */
export const IPC_CHANNELS = {
  // ── 应用级 ────────────────────────────────────────
  APP_GET_STATUS: 'app:getStatus',
  APP_OPEN_EXTERNAL: 'app:openExternal',
} as const;

/** IPC Channel 字面量联合类型 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
