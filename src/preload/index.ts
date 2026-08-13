// src/preload/index.ts
// Preload 脚本：在 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §5.4 类型契约单一来源 / §4.7 traceId 注入
//
// 职责：
// 1. 通过 createIpcApi(IPC_META) 自动生成 window.api（遍历定义表，零手写）
// 2. 通过 contextBridge.exposeInMainWorld('api', api) 暴露给渲染层
// 3. 请求-响应 channel 走 invoke（自动注入 traceId，见 ipc-bridge.ts）
// 4. 流式事件 channel 走 subscribe（返回 unsubscribe 函数，防内存泄漏）
//
// 类型契约：
// - IpcApi 接口由 IPC_DEFINITIONS 推导（packages/shared/src/ipc/definitions.ts 单一真源）
// - 生成器返回类型断言为 IpcApi，形状由类型系统保证与定义表同步
//
// 安全：
// - contextIsolation: true 下，contextBridge.exposeInMainWorld 是唯一安全暴露方式
// - 渲染层无法直接访问 ipcRenderer / Node API，只能通过 api 命名空间调用白名单方法
// - 每个 channel 名从 IPC_META 常量获取，避免拼写错误
//
// 导入策略（关键）：
// - IPC_META 通过子路径 '@code-agent/shared/ipc/meta' 导入（纯字符串，零 zod 依赖），
//   避免把 zod（纯 ESM 包）拉进 preload 构建产物。
// - sandbox: true 下 preload 必须是 CJS 格式，require('zod') 在沙箱中会失败，
//   导致 contextBridge.exposeInMainWorld 不执行，window.api 为 undefined。
// - IpcApi / IpcMeta 是 type-only 导入，esbuild 编译时会移除，不会触发运行时求值。

import { IPC_META } from '@code-agent/shared/ipc/meta';
import { contextBridge } from 'electron';
import { createIpcApi } from './utils/create-api';

// 自动生成 window.api 命名空间（零手写；域与方法数以 packages/shared/src/ipc/meta.ts 为唯一真源）
const api = createIpcApi(IPC_META);

// 通过 contextBridge 暴露到渲染层的 window.api（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api);
