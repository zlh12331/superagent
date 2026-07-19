// src/main/ipc/mock-handlers.ts
// E2E 测试模式 mock IPC handler（Electron 主进程侧）
// 设计文档 §8.4 E2E 测试策略 / Phase 10 Task 1
//
// 职责：
// - 在 E2E_MODE 下注册所有 IPC channel 的 mock handler
// - 返回预置空数据，让渲染层能正常渲染 UI
// - 不实际写入 DB，不调用真实 service
//
// 注意：
// - mock handler 使用与真实 handler 相同的 channel 名（IPC_CHANNELS）
// - 返回 IpcResponse 格式（{ data: T } | { error: IpcError }）
// - 仅在 E2E_MODE=true 时由 main/index.ts 调用
// - list 类返回空数组，get 类返回 NOT_FOUND，mutation 返回成功响应
//
// 当前使用状态（Phase 10）：
// - Playwright 走纯浏览器模式（playwright.config.ts webServer 访问 5173）
// - 浏览器中无 Electron preload，window.api 不存在
// - 此时由渲染层 api/client.ts 的 createMockApi() 提供 mock fallback
// - 本文件的 registerMockIpcHandlers() 在当前 E2E 流程中不实际执行
//   （主进程虽启动但 Playwright Chromium 不消费 IPC）
//
// 预留（Phase 11+）：
// - 切换到 Electron E2E 模式（Playwright + _electron）时启用
// - 届时主进程 mock handler 接管所有 IPC 调用，渲染层 apiClient 直连 preload
// - 与 client.ts 的 createMockApi 保持 mock 数据一致（DRY 待 Phase 11 抽公共模块）

import { ErrorCode, IPC_CHANNELS } from '@novel-writer/shared';
import { ipcMain } from 'electron';
import { logger } from '../utils/logger';

/** 当前时间戳（mock 数据用，模块加载时固定一次） */
const NOW = new Date().toISOString();

/**
 * 注册返回固定 data 的 mock handler
 *
 * @param channel IPC channel 名
 * @param data 返回的数据
 */
function mockData<T>(channel: string, data: T): void {
  ipcMain.handle(channel, () => ({ data }));
}

/**
 * 注册返回 NOT_FOUND 错误的 mock handler
 *
 * E2E 模式下无真实数据，get 类查询一律返回 NOT_FOUND。
 *
 * @param channel IPC channel 名
 */
function mockNotFound(channel: string): void {
  ipcMain.handle(channel, () => ({
    error: { code: ErrorCode.NOT_FOUND, message: '资源不存在（E2E 模式）' },
  }));
}

/**
 * 注册所有 mock IPC handler
 *
 * 在 E2E_MODE 下由 main/index.ts 调用，替代 registerIpcHandlers()。
 * 覆盖所有 41 个请求-响应 channel，返回预置空数据。
 *
 * 策略：
 * - list/tree 类：返回空数组
 * - get 类：返回 NOT_FOUND 错误（无真实数据）
 * - mutation create/update 类：返回 mock 对象（含 id 等必填字段）
 * - mutation delete 类：返回 { id }
 * - app:getStatus：返回健康状态（让 StatusBar 显示"已连接"）
 * - settings:get：返回默认设置
 */
export function registerMockIpcHandlers(): void {
  // ── 项目（6）──────────────────────────────────────
  mockData(IPC_CHANNELS.PROJECT_LIST, []);
  mockNotFound(IPC_CHANNELS.PROJECT_GET);
  mockData(IPC_CHANNELS.PROJECT_CREATE, {
    id: 'mock-project',
    name: 'Mock 项目',
    description: null,
    genre: null,
    cover: null,
    status: 'DRAFT',
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  });
  mockData(IPC_CHANNELS.PROJECT_UPDATE, {
    id: 'mock-project',
    name: 'Mock 项目',
    description: null,
    genre: null,
    cover: null,
    status: 'DRAFT',
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
  });
  mockData(IPC_CHANNELS.PROJECT_DELETE, { id: 'mock-project' });
  mockData(IPC_CHANNELS.PROJECT_ARCHIVE, {
    id: 'mock-project',
    name: 'Mock 项目',
    description: null,
    genre: null,
    cover: null,
    status: 'ARCHIVED',
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: NOW,
  });

  // ── 章节（6）──────────────────────────────────────
  mockData(IPC_CHANNELS.CHAPTER_LIST, []);
  mockNotFound(IPC_CHANNELS.CHAPTER_GET);
  mockData(IPC_CHANNELS.CHAPTER_CREATE, {
    id: 'mock-chapter',
    projectId: 'mock-project',
    volumeId: null,
    title: 'Mock 章节',
    content: '',
    wordCount: 0,
    status: 'DRAFT',
    sortOrder: 0,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.CHAPTER_UPDATE, {
    id: 'mock-chapter',
    projectId: 'mock-project',
    volumeId: null,
    title: 'Mock 章节',
    content: '',
    wordCount: 0,
    status: 'DRAFT',
    sortOrder: 0,
    metadata: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.CHAPTER_REORDER, []);
  mockData(IPC_CHANNELS.CHAPTER_DELETE, { id: 'mock-chapter' });

  // ── 人物（6）──────────────────────────────────────
  mockData(IPC_CHANNELS.CHARACTER_LIST, []);
  mockData(IPC_CHANNELS.CHARACTER_CREATE, {
    id: 'mock-character',
    projectId: 'mock-project',
    name: 'Mock 人物',
    avatar: null,
    role: 'PROTAGONIST',
    description: null,
    profile: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.CHARACTER_UPDATE, {
    id: 'mock-character',
    projectId: 'mock-project',
    name: 'Mock 人物',
    avatar: null,
    role: 'PROTAGONIST',
    description: null,
    profile: {},
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.CHARACTER_DELETE, { id: 'mock-character' });
  mockData(IPC_CHANNELS.CHARACTER_GET_RELATIONS, []);
  mockData(IPC_CHANNELS.CHARACTER_ADD_RELATION, {
    fromCharacterId: 'mock-character',
    toCharacterId: 'mock-character-2',
    type: 'friend',
  });

  // ── 世界观（4）────────────────────────────────────
  mockData(IPC_CHANNELS.WORLDVIEW_TREE, []);
  mockData(IPC_CHANNELS.WORLDVIEW_CREATE, {
    id: 'mock-worldview',
    projectId: 'mock-project',
    parentId: null,
    title: 'Mock 世界观',
    content: null,
    type: null,
    icon: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.WORLDVIEW_UPDATE, {
    id: 'mock-worldview',
    projectId: 'mock-project',
    parentId: null,
    title: 'Mock 世界观',
    content: null,
    type: null,
    icon: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.WORLDVIEW_DELETE, { id: 'mock-worldview' });

  // ── AI 对话（6）───────────────────────────────────
  mockData(IPC_CHANNELS.CHAT_LIST_SESSIONS, []);
  mockData(IPC_CHANNELS.CHAT_GET_MESSAGES, []);
  mockData(IPC_CHANNELS.CHAT_CREATE_SESSION, {
    id: 'mock-session',
    projectId: 'mock-project',
    title: 'Mock 会话',
    context: {},
    model: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.CHAT_SEND_MESSAGE, { ackId: 'mock-ack' });
  mockData(IPC_CHANNELS.CHAT_STOP_GENERATION, { stopped: true });
  mockData(IPC_CHANNELS.CHAT_DELETE_SESSION, { id: 'mock-session' });

  // ── RAG（4）───────────────────────────────────────
  mockData(IPC_CHANNELS.RAG_LIST_DOCUMENTS, []);
  mockData(IPC_CHANNELS.RAG_INGEST_DOCUMENT, { documentId: 'mock-doc', chunksCount: 0 });
  mockData(IPC_CHANNELS.RAG_SEARCH, []);
  mockData(IPC_CHANNELS.RAG_DELETE_DOCUMENT, { id: 'mock-doc' });

  // ── Agent 编排（3）────────────────────────────────
  mockData(IPC_CHANNELS.AGENT_GENERATE_CHAPTER, { ackId: 'mock-ack' });
  mockData(IPC_CHANNELS.AGENT_REWRITE, { ackId: 'mock-ack' });
  mockData(IPC_CHANNELS.AGENT_EXPAND_OUTLINE, { ackId: 'mock-ack' });

  // ── 设置（4）──────────────────────────────────────
  mockData(IPC_CHANNELS.SETTINGS_GET, {
    projectId: 'mock-project',
    aiModel: 'deepseek-v4-flash',
    aiTemperature: 0.7,
    aiMaxTokens: 4096,
    ragEnabled: true,
    ragTopK: 5,
    ragThreshold: 0.7,
    customPrompts: {},
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.SETTINGS_SET, {
    projectId: 'mock-project',
    aiModel: 'deepseek-v4-flash',
    aiTemperature: 0.7,
    aiMaxTokens: 4096,
    ragEnabled: true,
    ragTopK: 5,
    ragThreshold: 0.7,
    customPrompts: {},
    updatedAt: NOW,
  });
  mockData(IPC_CHANNELS.SETTINGS_SET_API_KEY, { ok: true });
  mockData(IPC_CHANNELS.SETTINGS_TEST_API_KEY, { ok: true, latencyMs: 0 });

  // ── 应用级（2）────────────────────────────────────
  mockData(IPC_CHANNELS.APP_GET_STATUS, {
    pgStatus: 'running',
    ollamaStatus: 'running',
    ollamaModelReady: true,
    dbConnected: true,
  });
  mockData(IPC_CHANNELS.APP_OPEN_EXTERNAL, { ok: true });

  logger.info({}, 'mock IPC handler 全部注册完成（E2E 模式，41 channel）');
}
