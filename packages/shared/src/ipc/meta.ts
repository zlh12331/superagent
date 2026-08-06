// packages/shared/src/ipc/meta.ts
// IPC 通道元数据（纯字符串，零依赖，preload 沙箱安全）
// ──────────────────────────────────────────────────────────────
// 为什么需要本文件：
// - preload 运行在 sandbox:true 下，不能 import 纯 ESM 包（如 zod）
// - definitions.ts 含 zod schema（运行时求值），preload 引入会静默失败
// - 因此把 channel + kind 提取为纯字符串元数据，preload 生成器只消费本文件
//
// 依赖方向：meta（零依赖）← definitions（加 schema）← channels（推导常量）
// ──────────────────────────────────────────────────────────────

/** 请求-响应方法元数据（channel + kind，无 schema） */
export const request = <C extends string>(channel: C) => ({ kind: 'request', channel }) as const;

/** 事件订阅方法元数据（channel + kind，无 payload 类型） */
export const event = <C extends string>(channel: C) => ({ kind: 'event', channel }) as const;

/**
 * IPC 通道元数据表（单一真源的 channel 部分）
 *
 * definitions.ts 在此基础上合并 zod schema 与类型标记；
 * preload 生成器（createIpcApi）直接遍历本表，无需加载 zod。
 */
export const IPC_META = {
  audio: {
    start: request('audio:start'),
    append: request('audio:append'),
    stop: request('audio:stop'),
  },

  app: {
    getStatus: request('app:getStatus'),
    openExternal: request('app:openExternal'),
    openDataDir: request('app:openDataDir'),
  },

  chat: {
    send: request('chat:send'),
    stop: request('chat:stop'),
    subscribePart: event('chat:stream:part'),
    subscribeEnd: event('chat:stream:end'),
    subscribeError: event('chat:stream:error'),
  },

  agent: {
    run: request('agent:run'),
    stop: request('agent:stop'),
    approvalResponse: request('agent:approval:response'),
    subscribeStreamPart: event('agent:stream:part'),
    subscribeStreamEnd: event('agent:stream:end'),
    subscribeStreamError: event('agent:stream:error'),
    subscribeToolCall: event('agent:tool:call'),
    subscribeToolResult: event('agent:tool:result'),
    subscribeApprovalRequest: event('agent:approval:request'),
    subscribeTurnEvent: event('agent:turn:event'),
  },

  session: {
    list: request('session:list'),
    get: request('session:get'),
    delete: request('session:delete'),
    rename: request('session:rename'),
    create: request('session:create'),
    listRecentDirs: request('session:listRecentDirs'),
    exportAll: request('session:exportAll'),
    getUsageSummary: request('session:getUsageSummary'),
    getTurns: request('session:getTurns'),
    getRecentTurns: request('session:getRecentTurns'),
    getTurnMessages: request('session:getTurnMessages'),
  },

  file: {
    read: request('file:read'),
    write: request('file:write'),
    list: request('file:list'),
    watchStart: request('file:watch:start'),
    watchStop: request('file:watch:stop'),
    subscribeWatchEvent: event('file:watch:event'),
    create: request('file:create'),
    createDir: request('file:createDir'),
    delete: request('file:delete'),
    rename: request('file:rename'),
  },

  search: {
    grep: request('search:grep'),
    glob: request('search:glob'),
  },

  terminal: {
    create: request('terminal:create'),
    input: request('terminal:input'),
    resize: request('terminal:resize'),
    kill: request('terminal:kill'),
    subscribeCreatedEvent: event('terminal:event:created'),
    subscribeOutputEvent: event('terminal:event:output'),
    subscribeExitEvent: event('terminal:event:exit'),
  },

  git: {
    status: request('git:status'),
    diff: request('git:diff'),
    add: request('git:add'),
    commit: request('git:commit'),
    push: request('git:push'),
  },

  codebase: {
    query: request('codebase:query'),
    explore: request('codebase:explore'),
    node: request('codebase:node'),
    callers: request('codebase:callers'),
    callees: request('codebase:callees'),
    impact: request('codebase:impact'),
  },

  tool: {
    list: request('tool:list'),
  },

  settings: {
    getApiKey: request('settings:getApiKey'),
    setApiKey: request('settings:setApiKey'),
    deleteApiKey: request('settings:deleteApiKey'),
    getTelemetryLevel: request('settings:getTelemetryLevel'),
    setTelemetryLevel: request('settings:setTelemetryLevel'),
    getApprovalMode: request('settings:getApprovalMode'),
    setApprovalMode: request('settings:setApprovalMode'),
    addRuntimeModel: request('settings:addRuntimeModel'),
    removeRuntimeModel: request('settings:removeRuntimeModel'),
    listRuntimeModels: request('settings:listRuntimeModels'),
  },

  system: {
    getStatus: request('system:getStatus'),
  },

  memory: {
    list: request('memory:list'),
    clear: request('memory:clear'),
  },

  task: {
    list: request('task:list'),
  },

  skill: {
    list: request('skill:list'),
    learn: request('skill:learn'),
    listLearned: request('skill:listLearned'),
    removeLearned: request('skill:removeLearned'),
  },

  goal: {
    create: request('goal:create'),
    list: request('goal:list'),
    clear: request('goal:clear'),
  },

  im: {
    list: request('im:list'),
    start: request('im:start'),
    stop: request('im:stop'),
  },

  logs: {
    read: request('logs:read'),
  },

  devtools: {
    open: request('devtools:open'),
  },

  dialog: {
    pickDirectory: request('dialog:pickDirectory'),
    pickFiles: request('dialog:pickFiles'),
  },

  update: {
    check: request('update:check'),
    install: request('update:install'),
    subscribeStatus: event('update:event:status'),
  },
} as const;

/** IPC 元数据表类型 */
export type IpcMeta = typeof IPC_META;

/** 元数据条目形状 */
export type MetaEntry = { readonly kind: 'request' | 'event'; readonly channel: string };
