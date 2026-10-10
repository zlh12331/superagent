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
  app: {
    getStatus: request('app:getStatus'),
    getInfo: request('app:getInfo'),
    openExternal: request('app:openExternal'),
    openDataDir: request('app:openDataDir'),
    exportDiagnostics: request('app:exportDiagnostics'),
    getLoginItemSettings: request('app:getLoginItemSettings'),
    setLoginItemSettings: request('app:setLoginItemSettings'),
    quit: request('app:quit'),
    subscribeDeepLink: event('app:event:deepLink'),
    subscribeLoginItemChanged: event('app:event:loginItemChanged'),
  },

  window: {
    applyZoom: request('window:applyZoom'),
  },

  backup: {
    list: request('backup:list'),
    create: request('backup:create'),
    restore: request('backup:restore'),
  },

  agent: {
    run: request('agent:run'),
    subscribeAsk: event('agent:event:ask'),
    subscribeAskResolved: event('agent:event:ask:resolved'),
    respondAsk: request('agent:ask:respond'),
    stop: request('agent:stop'),
    approvalResponse: request('agent:approval:response'),
    subscribeStreamPart: event('agent:stream:part'),
    subscribeStreamStart: event('agent:stream:start'),
    subscribeStreamEnd: event('agent:stream:end'),
    subscribeStreamError: event('agent:stream:error'),
    subscribeToolCall: event('agent:tool:call'),
    subscribeToolResult: event('agent:tool:result'),
    subscribeApprovalRequest: event('agent:approval:request'),
    subscribeApprovalResolved: event('agent:approval:resolved'),
  },

  session: {
    list: request('session:list'),
    get: request('session:get'),
    delete: request('session:delete'),
    clearAll: request('session:clearAll'),
    rename: request('session:rename'),
    pin: request('session:pin'),
    create: request('session:create'),
    listRecentDirs: request('session:listRecentDirs'),
    exportAll: request('session:exportAll'),
    importAll: request('session:import'),
    getUsageSummary: request('session:getUsageSummary'),
    getTurns: request('session:getTurns'),
    getRecentTurns: request('session:getRecentTurns'),
    getTurnMessages: request('session:getTurnMessages'),
    compact: request('session:compact'),
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

  browser: {
    navigate: request('browser:navigate'),
    back: request('browser:back'),
    forward: request('browser:forward'),
    reload: request('browser:reload'),
    setViewport: request('browser:setViewport'),
    configure: request('browser:configure'),
    getState: request('browser:getState'),
    subscribeState: event('browser:event:state'),
    subscribeLoadFailed: event('browser:event:loadFailed'),
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

  tool: {
    list: request('tool:list'),
  },

  settings: {
    getAll: request('settings:getAll'),
    set: request('settings:set'),
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
    updateRuntimeModel: request('settings:updateRuntimeModel'),
    exportSettings: request('settings:export'),
    importSettings: request('settings:import'),
    resetAll: request('settings:resetAll'),
    subscribeChanged: event('settings:event:changed'),
  },

  proxy: {
    test: request('proxy:test'),
  },

  system: {
    getStatus: request('system:getStatus'),
  },

  models: {
    list: request('models:list'),
    listBuiltin: request('models:listBuiltin'),
    test: request('models:test'),
  },

  memory: {
    list: request('memory:list'),
    clear: request('memory:clear'),
    clearAll: request('memory:clearAll'),
    status: request('memory:status'),
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

  whitelist: {
    list: request('whitelist:list'),
    add: request('whitelist:add'),
    remove: request('whitelist:remove'),
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

  remote: {
    getStatus: request('remote:getStatus'),
    start: request('remote:start'),
    stop: request('remote:stop'),
    setBindScope: request('remote:setBindScope'),
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

  mcp: {
    list: request('mcp:list'),
    start: request('mcp:start'),
    stop: request('mcp:stop'),
  },

  invalidation: {
    subscribeDomains: event('invalidation:event:domains'),
  },

  update: {
    check: request('update:check'),
    install: request('update:install'),
    cancel: request('update:cancel'),
    getStatus: request('update:getStatus'),
    getCacheInfo: request('update:getCacheInfo'),
    clearCache: request('update:clearCache'),
    subscribeStatus: event('update:event:status'),
  },
} as const;

/** IPC 元数据表类型 */
export type IpcMeta = typeof IPC_META;

/** 元数据条目形状 */
export type MetaEntry = { readonly kind: 'request' | 'event'; readonly channel: string };
