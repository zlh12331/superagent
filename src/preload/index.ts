// src/preload/index.ts
// Preload 脚本：在 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §5.4 类型契约单一来源 / §4.7 traceId 注入
//
// 职责：
// 1. 实现 IpcApi 接口（app 域 + chat 域）
// 2. 通过 contextBridge.exposeInMainWorld('api', api) 暴露给渲染层
// 3. 请求-响应 channel 走 invoke（自动注入 traceId）
// 4. 流式事件 channel 走 subscribe（返回 unsubscribe 函数）
//
// 类型契约：
// - IpcApi 接口定义在 packages/shared/src/ipc/api.ts（单一来源）
// - 此处用 `satisfies IpcApi` 编译时校验，确保形状与接口完全一致
// - 渲染层通过 window.api 访问，类型由全局 Window 扩展声明提供
//
// 安全：
// - contextIsolation: true 下，contextBridge.exposeInMainWorld 是唯一安全暴露方式
// - 渲染层无法直接访问 ipcRenderer / Node API，只能通过 api 命名空间调用白名单方法
// - 每个 channel 名从 IPC_CHANNELS 常量获取，避免拼写错误
//
// 导入策略（关键）：
// - IPC_CHANNELS 通过子路径 '@novel-writer/shared/ipc/channels' 导入，
//   避免触发 shared 主入口（src/index.ts）中可能的 zod 求值，
//   防止把 zod（纯 ESM 包）拉进 preload 构建产物。
// - sandbox: true 下 preload 必须是 CJS 格式，require('zod') 在沙箱中会失败，
//   导致 contextBridge.exposeInMainWorld 不执行，window.api 为 undefined。
// - IpcApi 是 type-only 导入，esbuild 编译时会移除，不会触发运行时求值。
//
// 说明：业务相关 channel（project/chapter/character/worldview/rag/agent/settings）
// 已随数据库层一并删除，当前保留应用级 + chat 域作为 LLM 客户端基础设施。

import type { IpcApi } from '@novel-writer/shared';
import { IPC_CHANNELS } from '@novel-writer/shared/ipc/channels';
import { contextBridge } from 'electron';
import { invoke, subscribe } from './utils/ipc-bridge';

/**
 * IpcApi 实现：window.api 命名空间
 *
 * 包含两个域：
 *
 * 1. app 域（请求-响应模式）
 *    - app:getStatus：查询应用就绪状态
 *    - app:openExternal：通过系统浏览器打开外链
 *
 * 2. chat 域（Vercel AI SDK v7，混合模式）
 *    - chat:send（请求-响应）：发起对话，返回 sessionId
 *    - chat:stop（请求-响应）：中断指定 sessionId 的对话
 *    - chat:stream:part（事件订阅）：流式 UIMessageStreamPart 推送
 *    - chat:stream:end（事件订阅）：流正常结束
 *    - chat:stream:error（事件订阅）：流异常终止
 *
 * 渲染层调用示例：
 * ```ts
 * // 应用级
 * const { data } = await window.api.app.getStatus();
 * await window.api.app.openExternal({ url: 'https://example.com' });
 *
 * // 聊天域（通常通过 IpcChatTransport + useChat 间接调用，不直接调用 chat 域 API）
 * const { data } = await window.api.chat.send({ messages, sessionId: undefined });
 * const off = window.api.chat.subscribePart(({ sessionId, part }) => {
 *   console.log('收到 part:', part);
 * });
 * // 卸载时
 * off();
 * ```
 */
const api = {
  // ── 应用级 ────────────────────────────────────────
  // getStatus / openExternal 均为请求-响应模式
  app: {
    getStatus: () => invoke(IPC_CHANNELS.APP_GET_STATUS),
    openExternal: (input: { url: string }) => invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, input),
  },

  // ── 聊天域（Vercel AI SDK v7）─────────────────────────
  // send / stop 为请求-响应模式，subscribePart / subscribeEnd / subscribeError 为事件订阅模式
  // 渲染层通常不直接调用 chat 域 API，而是通过 IpcChatTransport（实现 ChatTransport 接口）
  // 包装为 ReadableStream<UIMessageStreamPart> 后交给 useChat 消费
  chat: {
    // 发起对话：传入消息历史，返回 sessionId（渲染层用此 id 订阅后续流式事件）
    send: (input) => invoke(IPC_CHANNELS.CHAT_SEND, input),
    // 中断指定 sessionId 的对话（已结束则返回 stopped=false）
    stop: (input) => invoke(IPC_CHANNELS.CHAT_STOP, input),
    // 订阅流式 part 事件：每收到一个 UIMessageStreamPart 触发一次回调
    // 返回 unsubscribe 函数，组件卸载时必须调用以移除监听器（防止内存泄漏）
    subscribePart: (callback) => subscribe(IPC_CHANNELS.CHAT_STREAM_PART, callback),
    // 订阅流正常结束事件：所有 part 发送完毕后触发一次
    subscribeEnd: (callback) => subscribe(IPC_CHANNELS.CHAT_STREAM_END, callback),
    // 订阅流异常结束事件：发生错误时触发一次（含 code + message）
    subscribeError: (callback) => subscribe(IPC_CHANNELS.CHAT_STREAM_ERROR, callback),
  },
} satisfies IpcApi;

// 通过 contextBridge 暴露到渲染层的 window.api（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api);
