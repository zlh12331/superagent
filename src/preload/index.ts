// src/preload/index.ts
// Preload 脚本：在 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §5.4 类型契约单一来源 / §4.7 traceId 注入
//
// 职责：
// 1. 实现 IpcApi 接口（当前仅 app 域 2 个 channel）
// 2. 通过 contextBridge.exposeInMainWorld('api', api) 暴露给渲染层
// 3. 请求-响应 channel 走 invoke（自动注入 traceId）
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
// 说明：业务相关 channel（project/chapter/character/worldview/chat/rag/agent/settings）
// 已随数据库层一并删除，当前仅保留应用级 channel 作为 Electron 模版基础设施。

import type { IpcApi } from '@novel-writer/shared';
import { IPC_CHANNELS } from '@novel-writer/shared/ipc/channels';
import { contextBridge } from 'electron';
import { invoke } from './utils/ipc-bridge';

/**
 * IpcApi 实现：window.api 命名空间
 *
 * 仅 app 域 2 个 channel：
 * - app:getStatus：查询应用就绪状态
 * - app:openExternal：通过系统浏览器打开外链
 *
 * 渲染层调用示例：
 * ```ts
 * const { data } = await window.api.app.getStatus();
 * await window.api.app.openExternal({ url: 'https://example.com' });
 * ```
 */
const api = {
  // ── 应用级 ────────────────────────────────────────
  // getStatus / openExternal 均为请求-响应模式
  app: {
    getStatus: () => invoke(IPC_CHANNELS.APP_GET_STATUS),
    openExternal: (input: { url: string }) => invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, input),
  },
} satisfies IpcApi;

// 通过 contextBridge 暴露到渲染层的 window.api（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api);
