// src/renderer/api/client.ts
// IPC 客户端封装
// 设计文档 §5.1 数据流 / §7.4 错误处理流程 / §8.4 E2E 测试策略
//
// 职责：
// 1. 暴露 window.api 给渲染层（通过 apiClient 别名）
// 2. unwrap() 解包 IpcResponse，失败时抛 AppError
// 3. E2E 模式下提供 mock fallback（window.api 不存在时，符合 §8.4）
//
// E2E 测试架构（设计文档 §8.4）：
// - Playwright 走纯浏览器模式访问 http://localhost:5173（renderer dev server）
// - 浏览器中无 Electron preload，window.api 不存在
// - 此时通过 createMockApi() 返回预置空数据，让 UI 能正常渲染
// - 真实 Electron 环境下 preload 加载成功，window.api 存在，走真实 IPC

import { AppError, ErrorCode, type IpcApi, type IpcResponse } from '@novel-writer/shared';

/**
 * 创建 mock IPC API（用于 Playwright 浏览器模式 E2E 测试）
 *
 * 设计文档 §8.4：当 window.api 不存在时（纯浏览器测试），返回预置空数据。
 * 与主进程 mock-handlers.ts 保持一致的返回格式和 mock 数据。
 */
function createMockApi(): IpcApi {
  const now = new Date().toISOString();

  /** 返回成功响应 */
  const success = <T>(data: T): IpcResponse<T> => ({ data });

  /** 返回 NOT_FOUND 错误（E2E 模式下无真实数据，get 类查询一律返回） */
  const notFound = <T>(): IpcResponse<T> => ({
    error: { code: ErrorCode.NOT_FOUND, message: '资源不存在（E2E 模式）' },
  });

  return {
    project: {
      list: () => Promise.resolve(success([])),
      get: () => Promise.resolve(notFound()),
      create: () =>
        Promise.resolve(
          success({
            id: 'mock-project',
            name: 'Mock 项目',
            description: null,
            genre: null,
            cover: null,
            status: 'DRAFT',
            metadata: {},
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          }),
        ),
      update: () =>
        Promise.resolve(
          success({
            id: 'mock-project',
            name: 'Mock 项目',
            description: null,
            genre: null,
            cover: null,
            status: 'DRAFT',
            metadata: {},
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
          }),
        ),
      delete: () => Promise.resolve(success({ id: 'mock-project' })),
      archive: () =>
        Promise.resolve(
          success({
            id: 'mock-project',
            name: 'Mock 项目',
            description: null,
            genre: null,
            cover: null,
            status: 'ARCHIVED',
            metadata: {},
            createdAt: now,
            updatedAt: now,
            archivedAt: now,
          }),
        ),
    },
    chapter: {
      list: () => Promise.resolve(success([])),
      get: () => Promise.resolve(notFound()),
      create: () =>
        Promise.resolve(
          success({
            id: 'mock-chapter',
            projectId: 'mock-project',
            volumeId: null,
            title: 'Mock 章节',
            content: '',
            wordCount: 0,
            status: 'DRAFT',
            sortOrder: 0,
            metadata: {},
            createdAt: now,
            updatedAt: now,
          }),
        ),
      update: () =>
        Promise.resolve(
          success({
            id: 'mock-chapter',
            projectId: 'mock-project',
            volumeId: null,
            title: 'Mock 章节',
            content: '',
            wordCount: 0,
            status: 'DRAFT',
            sortOrder: 0,
            metadata: {},
            createdAt: now,
            updatedAt: now,
          }),
        ),
      reorder: () => Promise.resolve(success([])),
      delete: () => Promise.resolve(success({ id: 'mock-chapter' })),
    },
    character: {
      list: () => Promise.resolve(success([])),
      create: () =>
        Promise.resolve(
          success({
            id: 'mock-character',
            projectId: 'mock-project',
            name: 'Mock 人物',
            avatar: null,
            role: 'PROTAGONIST',
            description: null,
            profile: {},
            createdAt: now,
            updatedAt: now,
          }),
        ),
      update: () =>
        Promise.resolve(
          success({
            id: 'mock-character',
            projectId: 'mock-project',
            name: 'Mock 人物',
            avatar: null,
            role: 'PROTAGONIST',
            description: null,
            profile: {},
            createdAt: now,
            updatedAt: now,
          }),
        ),
      delete: () => Promise.resolve(success({ id: 'mock-character' })),
      getRelations: () => Promise.resolve(success([])),
      addRelation: () =>
        Promise.resolve(
          // 与主进程 mock-handlers.ts 保持一致（mock-character-2）
          success({
            fromCharacterId: 'mock-character',
            toCharacterId: 'mock-character-2',
            type: 'friend',
          }),
        ),
    },
    worldview: {
      tree: () => Promise.resolve(success([])),
      create: () =>
        Promise.resolve(
          success({
            id: 'mock-worldview',
            projectId: 'mock-project',
            parentId: null,
            title: 'Mock 世界观',
            content: null,
            type: null,
            icon: null,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      update: () =>
        Promise.resolve(
          success({
            id: 'mock-worldview',
            projectId: 'mock-project',
            parentId: null,
            title: 'Mock 世界观',
            content: null,
            type: null,
            icon: null,
            sortOrder: 0,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      delete: () => Promise.resolve(success({ id: 'mock-worldview' })),
    },
    chat: {
      listSessions: () => Promise.resolve(success([])),
      getMessages: () => Promise.resolve(success([])),
      createSession: () =>
        Promise.resolve(
          success({
            id: 'mock-session',
            projectId: 'mock-project',
            title: 'Mock 会话',
            context: {},
            model: null,
            createdAt: now,
            updatedAt: now,
          }),
        ),
      sendMessage: () => Promise.resolve(success({ ackId: 'mock-ack' })),
      stopGeneration: () => Promise.resolve(success({ stopped: true })),
      deleteSession: () => Promise.resolve(success({ id: 'mock-session' })),
      onStreamChunk: () => () => {},
      onStreamEnd: () => () => {},
      onStreamError: () => () => {},
    },
    rag: {
      listDocuments: () => Promise.resolve(success([])),
      ingestDocument: () => Promise.resolve(success({ documentId: 'mock-doc', chunksCount: 0 })),
      search: () => Promise.resolve(success([])),
      deleteDocument: () => Promise.resolve(success({ id: 'mock-doc' })),
    },
    agent: {
      generateChapter: () => Promise.resolve(success({ ackId: 'mock-ack' })),
      rewrite: () => Promise.resolve(success({ ackId: 'mock-ack' })),
      expandOutline: () => Promise.resolve(success({ ackId: 'mock-ack' })),
    },
    settings: {
      get: () =>
        Promise.resolve(
          success({
            projectId: 'mock-project',
            aiModel: 'deepseek-v4-flash',
            aiTemperature: 0.7,
            aiMaxTokens: 4096,
            ragEnabled: true,
            ragTopK: 5,
            ragThreshold: 0.7,
            customPrompts: {},
            updatedAt: now,
          }),
        ),
      set: () =>
        Promise.resolve(
          success({
            projectId: 'mock-project',
            aiModel: 'deepseek-v4-flash',
            aiTemperature: 0.7,
            aiMaxTokens: 4096,
            ragEnabled: true,
            ragTopK: 5,
            ragThreshold: 0.7,
            customPrompts: {},
            updatedAt: now,
          }),
        ),
      setApiKey: () => Promise.resolve(success({ ok: true })),
      testApiKey: () => Promise.resolve(success({ ok: true, latencyMs: 0 })),
    },
    app: {
      getStatus: () =>
        Promise.resolve(
          success({
            pgStatus: 'running',
            ollamaStatus: 'running',
            ollamaModelReady: true,
            dbConnected: true,
          }),
        ),
      openExternal: () => Promise.resolve(success({ ok: true })),
      onPgStatusChange: () => () => {},
      onOllamaStatusChange: () => () => {},
      onOllamaPullProgress: () => () => {},
    },
  };
}

/**
 * IPC 客户端：复用 preload 注入到 window.api 的 IpcApi 实例
 *
 * 渲染层统一通过 apiClient 调用 IPC，避免直接访问 window.api
 * （方便后续替换 mock 或加埋点）。
 *
 * - 真实 Electron 环境：window.api 由 preload 注入，走真实 IPC
 * - Playwright 浏览器模式（§8.4）：window.api 不存在，自动 fallback 到 createMockApi()
 *
 * @example
 * const res = await apiClient.project.list();
 */
export const apiClient: IpcApi = (window as unknown as { api?: IpcApi }).api ?? createMockApi();

/**
 * 解包 IpcResponse，失败时抛 AppError
 *
 * IpcResponse 是 discriminated union：`{ data } | { error }`
 * 用 `'data' in res` 进行类型收窄
 *
 * @example
 * const res = await apiClient.project.list();
 * const projects = unwrap(res); // 失败时抛 AppError
 */
export function unwrap<T>(res: IpcResponse<T>): T {
  if ('data' in res) {
    return res.data;
  }
  throw new AppError(res.error.code, res.error.message, undefined, res.error.details);
}
