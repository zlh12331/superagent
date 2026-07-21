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
// 说明：
// - 业务相关 channel（project/chapter/character/worldview/rag/agent/settings）
//   已随数据库层一并删除
// - 当前保留应用级 channel + chat 域 channel（基于 Vercel AI SDK v7）

/**
 * IPC Channel 常量表
 *
 * 包含：
 * - 应用级：APP_GET_STATUS / APP_OPEN_EXTERNAL
 * - 聊天域：CHAT_SEND（请求-响应，发起对话）/ CHAT_STOP（请求-响应，中断对话）
 *           CHAT_STREAM_PART（流式事件，逐 part 推送 UIMessageStreamPart）
 *           CHAT_STREAM_END（流式事件，正常结束）
 *           CHAT_STREAM_ERROR（流式事件，异常结束）
 */
export const IPC_CHANNELS = {
  // ── 应用级 ────────────────────────────────────────
  APP_GET_STATUS: 'app:getStatus',
  APP_OPEN_EXTERNAL: 'app:openExternal',

  // ── 聊天域（Vercel AI SDK v7） ──────────────────────
  // 请求-响应：渲染层发起对话，返回 sessionId
  CHAT_SEND: 'chat:send',
  // 请求-响应：渲染层中断指定 sessionId 的对话
  CHAT_STOP: 'chat:stop',
  // 流式事件：主进程逐 part 推送 UIMessageStreamPart（文本 chunk / tool 调用 / thinking 等）
  CHAT_STREAM_PART: 'chat:stream:part',
  // 流式事件：流正常结束
  CHAT_STREAM_END: 'chat:stream:end',
  // 流式事件：流异常结束
  CHAT_STREAM_ERROR: 'chat:stream:error',
} as const;

/** IPC Channel 字面量联合类型 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
