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

export const IPC_CHANNELS = {
  // ── 项目 ──────────────────────────────────────────
  PROJECT_CREATE: 'project:create',
  PROJECT_LIST: 'project:list',
  PROJECT_GET: 'project:get',
  PROJECT_UPDATE: 'project:update',
  PROJECT_DELETE: 'project:delete',
  PROJECT_ARCHIVE: 'project:archive',

  // ── 章节 ──────────────────────────────────────────
  CHAPTER_CREATE: 'chapter:create',
  CHAPTER_LIST: 'chapter:list',
  CHAPTER_GET: 'chapter:get',
  CHAPTER_UPDATE: 'chapter:update',
  CHAPTER_REORDER: 'chapter:reorder',
  CHAPTER_DELETE: 'chapter:delete',

  // ── 人物 ──────────────────────────────────────────
  CHARACTER_CREATE: 'character:create',
  CHARACTER_LIST: 'character:list',
  CHARACTER_UPDATE: 'character:update',
  CHARACTER_DELETE: 'character:delete',
  CHARACTER_GET_RELATIONS: 'character:getRelations',
  CHARACTER_ADD_RELATION: 'character:addRelation',

  // ── 世界观 ────────────────────────────────────────
  WORLDVIEW_CREATE: 'worldview:create',
  WORLDVIEW_TREE: 'worldview:tree',
  WORLDVIEW_UPDATE: 'worldview:update',
  WORLDVIEW_DELETE: 'worldview:delete',

  // ── AI 对话 ───────────────────────────────────────
  CHAT_CREATE_SESSION: 'chat:createSession',
  CHAT_LIST_SESSIONS: 'chat:listSessions',
  CHAT_GET_MESSAGES: 'chat:getMessages',
  CHAT_SEND_MESSAGE: 'chat:sendMessage',
  CHAT_STOP_GENERATION: 'chat:stopGeneration',
  CHAT_DELETE_SESSION: 'chat:deleteSession',

  // 流式事件（M→R）
  CHAT_STREAM_CHUNK: 'chat:stream:chunk',
  CHAT_STREAM_END: 'chat:stream:end',
  CHAT_STREAM_ERROR: 'chat:stream:error',

  // ── RAG ───────────────────────────────────────────
  RAG_INGEST_DOCUMENT: 'rag:ingestDocument',
  RAG_SEARCH: 'rag:search',
  RAG_LIST_DOCUMENTS: 'rag:listDocuments',
  RAG_DELETE_DOCUMENT: 'rag:deleteDocument',

  // ── Agent 编排 ────────────────────────────────────
  AGENT_GENERATE_CHAPTER: 'agent:generateChapter',
  AGENT_REWRITE: 'agent:rewrite',
  AGENT_EXPAND_OUTLINE: 'agent:expandOutline',

  // ── 设置 ──────────────────────────────────────────
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_SET_API_KEY: 'settings:setApiKey',
  SETTINGS_TEST_API_KEY: 'settings:testApiKey',

  // ── 应用级 ────────────────────────────────────────
  APP_GET_STATUS: 'app:getStatus',
  APP_OPEN_EXTERNAL: 'app:openExternal',

  // 状态变更事件（M→R）
  APP_EVENT_PG_STATUS: 'app:event:pgStatus',
  APP_EVENT_OLLAMA_STATUS: 'app:event:ollamaStatus',
  APP_EVENT_OLLAMA_PULL_PROGRESS: 'app:event:ollamaPullProgress',
} as const;

/** IPC Channel 字面量联合类型 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
