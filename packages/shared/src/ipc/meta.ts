// meta.ts：IPC 通道元数据表（channel + kind 的纯字符串单一真源，按域分组）
//
// 为什么单独成表：preload 运行在 sandbox: true 下，引入含 zod 的 definitions.ts 会静默失败
// （window.api 变 undefined）——故 channel/kind 抽成零依赖字符串，由 preload 生成器
// （src/preload/utils/create-api.ts 的 createIpcApi）直接遍历本表，无需加载 zod。
// 边界：本文件不装 schema 与类型标记（definitions.ts 在其上合并），也不定义失败语义。
// 依赖方向：meta（本文件）← definitions.ts（+ zod schema）← channels.ts（deriveChannels 推导常量）。
// 增改约束：域键即 channel 前缀，deriveChannels 在 channel 与域键不匹配时直接抛错；
// channel 形态：请求 {domain}:{action}，事件 {domain}:event:{name} / {domain}:stream:{event}。
// 新增一个 IPC 方法 = 本表一行 + definitions.ts 一行 + 主进程 handler 一个方法，其余自动。
/**
 * 声明一个请求-响应方法（渲染层调用后等待返回）
 *
 * 返回值用 `as const` 保持字面量类型：derive.ts 的通道键名推导与定义表的 kind 判别
 * 都依赖字面量，一旦被拓宽成 string，IpcApi / InferHandlers 的推导会整体落空。
 */
export const request = <C extends string>(channel: C) => ({ kind: 'request', channel }) as const;

/**
 * 声明一个事件订阅方法：渲染层订阅并用返回的函数退订
 *
 * 与 request 的差别是单向推送（调用不返回结果）；payload 类型由 definitions.ts 的
 * payload 标记补上，本表不承载。
 */
export const event = <C extends string>(channel: C) => ({ kind: 'event', channel }) as const;

/**
 * IPC 通道元数据表（单一真源的 channel 部分，按域分组）
 *
 * definitions.ts 在此基础上合并 zod schema 与类型标记；
 * preload 生成器（createIpcApi）直接遍历本表，无需加载 zod。
 * 条目一律经 request / event 包裹——kind 字段参与定义表判别，手写对象会破坏类型推导。
 */
export const IPC_META = {
  app: {
    getStatus: request('app:getStatus'),
    getInfo: request('app:getInfo'),
    openExternal: request('app:openExternal'),
    openDataDir: request('app:openDataDir'),
    // 诊断包导出：日志 + 版本信息 → 用户选定路径的 zip（排障闭环的出口）
    exportDiagnostics: request('app:exportDiagnostics'),
    // 开机自启：读写 OS 登录项而非 SQLite 设置——托盘菜单与设置页必须同源
    getLoginItemSettings: request('app:getLoginItemSettings'),
    setLoginItemSettings: request('app:setLoginItemSettings'),
    // 退出应用：交给 app.quit 走完整善后链（关窗协商 → dispose 把残留 running 回合标 interrupted）
    quit: request('app:quit'),
    // 深链接事件：code-agent:// 协议唤起时主进程广播，渲染层据此导航
    subscribeDeepLink: event('app:event:deepLink'),
    // 登录项变更事件：payload 为写入后的真实回读值（托盘菜单改自启 → 设置页回显）
    subscribeLoginItemChanged: event('app:event:loginItemChanged'),
  },

  window: {
    // 界面缩放：主进程统一 setZoomFactor（渲染层只管上报档位），并联动 Windows
    // titleBarOverlay 高度——固定高度不随 CSS 缩放，不联动会与自绘顶栏错位
    applyZoom: request('window:applyZoom'),
  },

  backup: {
    // 恢复点列表：backups/ 轮转环 + quick_check 健康度，最新在前
    list: request('backup:list'),
    // 立即备份：与启动备份走同一路径、进同一轮转环（同样会被轮转淘汰）
    create: request('backup:create'),
    // 从恢复点恢复：暂存 + 重启生效，有运行中回合先拒绝（SESSION_IN_USE）
    restore: request('backup:restore'),
  },

  agent: {
    run: request('agent:run'),
    subscribeAsk: event('agent:event:ask'),
    // 提问决议事件（含超时等非用户路径）：与 subscribeAsk 配对——有提问必有决议，
    // 渲染层据此把提问移出队列，否则残留「僵尸弹窗」并阻塞队头
    subscribeAskResolved: event('agent:event:ask:resolved'),
    respondAsk: request('agent:ask:respond'),
    stop: request('agent:stop'),
    approvalResponse: request('agent:approval:response'),
    subscribeStreamPart: event('agent:stream:part'),
    // 回合开始事件：把该会话乐观置为 running（侧栏运行徽标），与 stream:end / error 配对收尾
    subscribeStreamStart: event('agent:stream:start'),
    subscribeStreamEnd: event('agent:stream:end'),
    subscribeStreamError: event('agent:stream:error'),
    subscribeToolCall: event('agent:tool:call'),
    subscribeToolResult: event('agent:tool:result'),
    subscribeApprovalRequest: event('agent:approval:request'),
    // 审批决议事件（含超时/中断等非用户路径）：与 subscribeApprovalRequest 配对——有请求必有决议，
    // 渲染层据此清掉待审批条目，否则残留「僵尸审批卡」
    subscribeApprovalResolved: event('agent:approval:resolved'),
  },

  session: {
    list: request('session:list'),
    get: request('session:get'),
    delete: request('session:delete'),
    // 清空全部会话（破坏性批量操作）：主进程对运行中回合直接拒绝（SESSION_IN_USE）
    clearAll: request('session:clearAll'),
    rename: request('session:rename'),
    pin: request('session:pin'),
    create: request('session:create'),
    listRecentDirs: request('session:listRecentDirs'),
    exportAll: request('session:exportAll'),
    // 导入会话（只接受 version=1 导出文件）：同 id 已存在则整体跳过并计数——不合并、不覆盖
    importAll: request('session:import'),
    getUsageSummary: request('session:getUsageSummary'),
    // 单会话回合摘要列表（按 seq 升序）
    getTurns: request('session:getTurns'),
    // 跨会话最近回合（按 createdAt 倒序；设置页回合记录展示用）
    getRecentTurns: request('session:getRecentTurns'),
    // 单个回合的消息明细（按 seq 升序）
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
    // 视口同步：渲染层测量占位区后推送矩形/缩放/可见性（高频 invoke；不可见时仅隐藏，页面保活）
    setViewport: request('browser:setViewport'),
    // 严格模式切换（禁用预览页 JS）：与当前值不同才销毁重建视图并回放当前 URL
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
    // 设置导出/导入（app_settings 全表 JSON，version=1 格式；API Key 等 keychain 凭据不在其中）
    exportSettings: request('settings:export'),
    importSettings: request('settings:import'),
    // 恢复全部设置为默认：删除 SETTING_KEYS 全部键（app_settings 回到空表）
    resetAll: request('settings:resetAll'),
    // 设置变更事件：主进程侧的写入（如托盘菜单改关窗行为）广播该域新值，设置页据此回显
    subscribeChanged: event('settings:event:changed'),
  },

  proxy: {
    // 代理连通性探测：主进程先重读库内配置注入 proxiedFetch 再探轻量端点；mode 非 fixed 返回 not-applicable
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
    // 清空全部记忆：上游无全清接口（删除需显式给出 key、单次上限 100），主进程枚举会话后分批删
    clearAll: request('memory:clearAll'),
    // 引擎状态：用户开关 / 随包可用性 / sidecar 运行与健康 / 数据量（读审计镜像，不触发引擎）
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
    // 缓存失效事件：主进程写路径声明受影响域后广播，渲染层按域前缀失效查询缓存
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
