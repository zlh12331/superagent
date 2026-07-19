// src/preload/index.ts
// Preload 脚本：在 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §5.4 类型契约单一来源 / §4.7 traceId 注入
//
// 职责：
// 1. 实现 IpcApi 完整接口（38 个 channel，9 个业务域）
// 2. 通过 contextBridge.exposeInMainWorld('api', api) 暴露给渲染层
// 3. 请求-响应 channel 走 invoke（自动注入 traceId）
// 4. 事件订阅 channel 走 subscribe（返回 unsubscribe 函数，防泄漏）
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

import { IPC_CHANNELS, type IpcApi } from '@novel-writer/shared';
import { contextBridge } from 'electron';
import { invoke, subscribe } from './utils/ipc-bridge';

/**
 * IpcApi 实现：window.api 命名空间
 *
 * 9 个业务域共 38 个 channel：
 * - 请求-响应（IpcInvokeMethod）：调用 invoke(channel, input)，返回 Promise<IpcResponse>
 * - 事件订阅（IpcSubscribeMethod）：调用 subscribe(channel, callback)，返回 unsubscribe
 *
 * 渲染层调用示例：
 * ```ts
 * // 请求-响应
 * const { data, error } = await window.api.project.create({ title: '我的小说', ... });
 * // 事件订阅
 * const off = window.api.chat.onStreamChunk((chunk) => { ... });
 * off(); // 卸载时取消订阅
 * ```
 */
const api = {
  // ── 项目 ──────────────────────────────────────────
  project: {
    create: (input) => invoke(IPC_CHANNELS.PROJECT_CREATE, input),
    list: () => invoke(IPC_CHANNELS.PROJECT_LIST),
    get: (input) => invoke(IPC_CHANNELS.PROJECT_GET, input),
    update: (input) => invoke(IPC_CHANNELS.PROJECT_UPDATE, input),
    delete: (input) => invoke(IPC_CHANNELS.PROJECT_DELETE, input),
    archive: (input) => invoke(IPC_CHANNELS.PROJECT_ARCHIVE, input),
  },

  // ── 章节 ──────────────────────────────────────────
  chapter: {
    create: (input) => invoke(IPC_CHANNELS.CHAPTER_CREATE, input),
    list: (input) => invoke(IPC_CHANNELS.CHAPTER_LIST, input),
    get: (input) => invoke(IPC_CHANNELS.CHAPTER_GET, input),
    update: (input) => invoke(IPC_CHANNELS.CHAPTER_UPDATE, input),
    reorder: (input) => invoke(IPC_CHANNELS.CHAPTER_REORDER, input),
    delete: (input) => invoke(IPC_CHANNELS.CHAPTER_DELETE, input),
  },

  // ── 人物 ──────────────────────────────────────────
  character: {
    create: (input) => invoke(IPC_CHANNELS.CHARACTER_CREATE, input),
    list: (input) => invoke(IPC_CHANNELS.CHARACTER_LIST, input),
    update: (input) => invoke(IPC_CHANNELS.CHARACTER_UPDATE, input),
    delete: (input) => invoke(IPC_CHANNELS.CHARACTER_DELETE, input),
    getRelations: (input) => invoke(IPC_CHANNELS.CHARACTER_GET_RELATIONS, input),
    addRelation: (input) => invoke(IPC_CHANNELS.CHARACTER_ADD_RELATION, input),
  },

  // ── 世界观 ────────────────────────────────────────
  worldview: {
    create: (input) => invoke(IPC_CHANNELS.WORLDVIEW_CREATE, input),
    tree: (input) => invoke(IPC_CHANNELS.WORLDVIEW_TREE, input),
    update: (input) => invoke(IPC_CHANNELS.WORLDVIEW_UPDATE, input),
    delete: (input) => invoke(IPC_CHANNELS.WORLDVIEW_DELETE, input),
  },

  // ── AI 对话 ───────────────────────────────────────
  // chat 域同时含请求-响应方法（createSession 等）和事件订阅方法（onStream*）
  chat: {
    createSession: (input) => invoke(IPC_CHANNELS.CHAT_CREATE_SESSION, input),
    listSessions: (input) => invoke(IPC_CHANNELS.CHAT_LIST_SESSIONS, input),
    getMessages: (input) => invoke(IPC_CHANNELS.CHAT_GET_MESSAGES, input),
    sendMessage: (input) => invoke(IPC_CHANNELS.CHAT_SEND_MESSAGE, input),
    stopGeneration: (input) => invoke(IPC_CHANNELS.CHAT_STOP_GENERATION, input),
    // 流式事件订阅：渲染层需在组件卸载时调用返回的 unsubscribe 函数
    onStreamChunk: (cb) => subscribe(IPC_CHANNELS.CHAT_STREAM_CHUNK, cb),
    onStreamEnd: (cb) => subscribe(IPC_CHANNELS.CHAT_STREAM_END, cb),
    onStreamError: (cb) => subscribe(IPC_CHANNELS.CHAT_STREAM_ERROR, cb),
  },

  // ── RAG ───────────────────────────────────────────
  rag: {
    ingestDocument: (input) => invoke(IPC_CHANNELS.RAG_INGEST_DOCUMENT, input),
    search: (input) => invoke(IPC_CHANNELS.RAG_SEARCH, input),
    listDocuments: (input) => invoke(IPC_CHANNELS.RAG_LIST_DOCUMENTS, input),
    deleteDocument: (input) => invoke(IPC_CHANNELS.RAG_DELETE_DOCUMENT, input),
  },

  // ── Agent 编排 ────────────────────────────────────
  // 3 个方法均为「立即返回 ackId，后台异步执行」模式（流式结果通过 chat 事件订阅）
  agent: {
    generateChapter: (input) => invoke(IPC_CHANNELS.AGENT_GENERATE_CHAPTER, input),
    rewrite: (input) => invoke(IPC_CHANNELS.AGENT_REWRITE, input),
    expandOutline: (input) => invoke(IPC_CHANNELS.AGENT_EXPAND_OUTLINE, input),
  },

  // ── 设置 ──────────────────────────────────────────
  settings: {
    get: (input) => invoke(IPC_CHANNELS.SETTINGS_GET, input),
    set: (input) => invoke(IPC_CHANNELS.SETTINGS_SET, input),
    setApiKey: (input) => invoke(IPC_CHANNELS.SETTINGS_SET_API_KEY, input),
    testApiKey: (input) => invoke(IPC_CHANNELS.SETTINGS_TEST_API_KEY, input),
  },

  // ── 应用级 ────────────────────────────────────────
  // getStatus / openExternal 为请求-响应；其余 3 个为状态变更事件订阅
  app: {
    getStatus: () => invoke(IPC_CHANNELS.APP_GET_STATUS),
    openExternal: (input) => invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, input),
    // PG / Ollama 状态变更 + 模型拉取进度事件，渲染层订阅后实时刷新 UI
    onPgStatusChange: (cb) => subscribe(IPC_CHANNELS.APP_EVENT_PG_STATUS, cb),
    onOllamaStatusChange: (cb) => subscribe(IPC_CHANNELS.APP_EVENT_OLLAMA_STATUS, cb),
    onOllamaPullProgress: (cb) => subscribe(IPC_CHANNELS.APP_EVENT_OLLAMA_PULL_PROGRESS, cb),
  },
} satisfies IpcApi;

// 通过 contextBridge 暴露到渲染层的 window.api（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api);
