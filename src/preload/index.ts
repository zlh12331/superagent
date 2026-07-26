// src/preload/index.ts
// Preload 脚本：在 contextIsolation 环境中暴露受限 API 到渲染层
// 设计文档 §4.9 Preload unsubscribe 模式 / §5.4 类型契约单一来源 / §4.7 traceId 注入
//
// 职责：
// 1. 实现 IpcApi 接口（10 个域：app/chat/agent/session/file/search/terminal/git/codebase/tool）
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

import type { IpcApi } from '@novel-writer/shared';
import { IPC_CHANNELS } from '@novel-writer/shared/ipc/channels';
import { contextBridge } from 'electron';
import { invoke, subscribe } from './utils/ipc-bridge';

/**
 * IpcApi 实现：window.api 命名空间
 *
 * 包含 10 个域：
 *
 * 1. app（应用级，请求-响应模式）
 *    - app:getStatus：查询应用就绪状态
 *    - app:openExternal：通过系统浏览器打开外链
 *
 * 2. chat（聊天域，Vercel AI SDK v7，混合模式）
 *    - chat:send / chat:stop（请求-响应）
 *    - chat:stream:part / end / error（事件订阅）
 *
 * 3. agent（Code Agent 核心，多轮工具调用，混合模式）
 *    - agent:run / agent:stop / agent:approval:response（请求-响应）
 *    - agent:stream:part / end / error（事件订阅，流式 part 推送）
 *    - agent:tool:call / result（事件订阅，工具调用事件）
 *    - agent:approval:request（事件订阅，审批请求）
 *
 * 4. session（会话持久化，请求-响应模式）
 *    - session:list / get / delete / rename
 *
 * 5. file（文件读写 + 目录列表 + 文件监听，混合模式）
 *    - file:read / write / list / watch:start / watch:stop（请求-响应）
 *    - file:watch:event（事件订阅）
 *
 * 6. search（搜索域，请求-响应模式）
 *    - search:grep / search:glob
 *
 * 7. terminal（终端会话池，混合模式）
 *    - terminal:create / input / resize / kill（请求-响应）
 *    - terminal:event:output / exit（事件订阅）
 *
 * 8. git（Git CLI 封装，请求-响应模式，只读）
 *    - git:status / git:diff
 *
 * 9. codebase（代码智能查询，请求-响应模式）
 *    - codebase:query / explore / node / callers / callees / impact
 *
 * 10. tool（工具系统元数据，请求-响应模式）
 *     - tool:list
 *
 * 渲染层调用示例：
 * ```ts
 * // 应用级
 * const { data } = await window.api.app.getStatus();
 * await window.api.app.openExternal({ url: 'https://example.com' });
 *
 * // 聊天域（通常通过 IpcChatTransport + useChat 间接调用，不直接调用 chat 域 API）
 * const { data } = await window.api.chat.send({ messages, sessionId: undefined });
 *
 * // Agent 域（Code Agent 核心，直接调用或通过 AgentTransport 间接调用）
 * const { data } = await window.api.agent.run({ messages, config: {} });
 *
 * // 会话域（会话列表展示与持久化）
 * const { data } = await window.api.session.list({ limit: 50, offset: 0 });
 *
 * // 文件域（文件读写与监听）
 * const { data } = await window.api.file.read({ path: '/tmp/test.txt' });
 * const off = window.api.file.subscribeWatchEvent(({ watcherId, event }) => {
 *   console.log('文件变更:', event);
 * });
 * // 卸载时
 * off();
 *
 * // 终端域（终端会话池）
 * const { data } = await window.api.terminal.create({ cwd: '/tmp' });
 * const off = window.api.terminal.subscribeOutputEvent(({ terminalId, data }) => {
 *   terminal.write(data);
 * });
 *
 * // Git 域
 * const { data } = await window.api.git.status({});
 *
 * // 代码库域
 * const { data } = await window.api.codebase.query({ query: 'class Foo' });
 *
 * // 工具域
 * const { data } = await window.api.tool.list({});
 * ```
 */
const api = {
  // ── 应用级（请求-响应模式）────────────────────────────
  app: {
    getStatus: () => invoke(IPC_CHANNELS.APP_GET_STATUS),
    openExternal: (input: { url: string }) => invoke(IPC_CHANNELS.APP_OPEN_EXTERNAL, input),
  },

  // ── 聊天域（Vercel AI SDK v7，混合模式）──────────────────
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

  // ── Agent 域（Code Agent 核心，多轮工具调用，混合模式）──────
  // run / stop / approvalResponse 为请求-响应模式
  // subscribeStream* / subscribeTool* / subscribeApprovalRequest 为事件订阅模式
  // 渲染层通过 AgentTransport 间接调用（待 P8.4-P8.5 实现）
  agent: {
    // 发起 agent 对话：传入消息历史与配置，返回 sessionId
    // 后续通过 agent:stream:* / agent:tool:* / agent:approval:* 推送事件
    run: (input) => invoke(IPC_CHANNELS.AGENT_RUN, input),
    // 中断指定 sessionId 的 agent 对话
    stop: (input) => invoke(IPC_CHANNELS.AGENT_STOP, input),
    // 回传审批结果：用户点击批准/拒绝后调用
    // 主进程收到后 resolve 对应 approvalId 的 Promise，ToolExecutor 继续/中止执行
    approvalResponse: (input) => invoke(IPC_CHANNELS.AGENT_APPROVAL_RESPONSE, input),
    // 订阅流式 part 事件：每收到一个 UIMessageStreamPart（text/tool-call/finish 等）触发
    subscribeStreamPart: (callback) => subscribe(IPC_CHANNELS.AGENT_STREAM_PART, callback),
    // 订阅 agent 对话结束事件：含 reason（completed/aborted/error）
    subscribeStreamEnd: (callback) => subscribe(IPC_CHANNELS.AGENT_STREAM_END, callback),
    // 订阅 agent 对话异常事件：含 code + message
    subscribeStreamError: (callback) => subscribe(IPC_CHANNELS.AGENT_STREAM_ERROR, callback),
    // 订阅工具调用事件：主进程推送工具调用入参与权限级别
    subscribeToolCall: (callback) => subscribe(IPC_CHANNELS.AGENT_TOOL_CALL, callback),
    // 订阅工具结果事件：主进程推送工具执行结果（含 output 或 error）
    subscribeToolResult: (callback) => subscribe(IPC_CHANNELS.AGENT_TOOL_RESULT, callback),
    // 订阅审批请求事件：主进程请求用户审批（permission='ask' 的工具调用）
    // 渲染层弹出 ApprovalModal，用户选择后通过 agent.approvalResponse 回传结果
    subscribeApprovalRequest: (callback) =>
      subscribe(IPC_CHANNELS.AGENT_APPROVAL_REQUEST, callback),
  },

  // ── 会话域（SQLite 持久化，请求-响应模式）──────────────────
  // SessionService 提供 list/get/delete/rename/create/listRecentDirs 六个 IPC 方法
  // appendMessage 是内部 API（供主进程 AgentService 调用），不通过 IPC 暴露
  session: {
    // 列出会话（分页查询，按 updatedAt 倒序）
    list: (input) => invoke(IPC_CHANNELS.SESSION_LIST, input),
    // 获取指定会话的完整消息历史
    get: (input) => invoke(IPC_CHANNELS.SESSION_GET, input),
    // 删除指定会话（外键级联删除关联消息）
    delete: (input) => invoke(IPC_CHANNELS.SESSION_DELETE, input),
    // 重命名会话标题
    rename: (input) => invoke(IPC_CHANNELS.SESSION_RENAME, input),
    // 创建新会话（绑定 workingDir，空会话）
    create: (input) => invoke(IPC_CHANNELS.SESSION_CREATE, input),
    // 查询最近使用的目录列表（去重 + 按 lastUsed 倒序）
    listRecentDirs: (input) => invoke(IPC_CHANNELS.SESSION_LIST_RECENT_DIRS, input),
  },

  // ── 文件域（文件读写 + 目录列表 + 文件监听，混合模式）────────
  // read / write / list / watchStart / watchStop 为请求-响应模式
  // subscribeWatchEvent 为事件订阅模式（chokidar 文件监听）
  file: {
    // 读取文件内容（支持分批，避免一次性加载大文件）
    read: (input) => invoke(IPC_CHANNELS.FILE_READ, input),
    // 写入文件（覆盖或追加）
    write: (input) => invoke(IPC_CHANNELS.FILE_WRITE, input),
    // 列出目录内容（带深度与隐藏文件过滤）
    list: (input) => invoke(IPC_CHANNELS.FILE_LIST, input),
    // 开始监听文件变更，返回 watcherId
    watchStart: (input) => invoke(IPC_CHANNELS.FILE_WATCH_START, input),
    // 停止监听指定 watcher
    watchStop: (input) => invoke(IPC_CHANNELS.FILE_WATCH_STOP, input),
    // 订阅文件变更事件（create/modify/delete/rename）
    subscribeWatchEvent: (callback) => subscribe(IPC_CHANNELS.FILE_WATCH_EVENT, callback),
    // 创建新文件
    create: (input) => invoke(IPC_CHANNELS.FILE_CREATE, input),
    // 创建新目录
    createDir: (input) => invoke(IPC_CHANNELS.FILE_CREATE_DIR, input),
    // 删除文件或目录
    delete: (input) => invoke(IPC_CHANNELS.FILE_DELETE, input),
    // 重命名/移动文件或目录
    rename: (input) => invoke(IPC_CHANNELS.FILE_RENAME, input),
  },

  // ── 搜索域（ripgrep + glob，请求-响应模式）──────────────────
  // 主进程通过子进程调用 ripgrep / 实现 glob 匹配
  search: {
    // 正则搜索文件内容（基于 ripgrep）
    grep: (input) => invoke(IPC_CHANNELS.SEARCH_GREP, input),
    // 按 glob 模式匹配文件路径
    glob: (input) => invoke(IPC_CHANNELS.SEARCH_GLOB, input),
  },

  // ── 终端域（node-pty 会话池，混合模式）──────────────────────
  // create / input / resize / kill 为请求-响应模式
  // subscribeOutputEvent / subscribeExitEvent 为事件订阅模式
  terminal: {
    // 创建终端会话，返回 terminalId
    create: (input) => invoke(IPC_CHANNELS.TERMINAL_CREATE, input),
    // 向终端写入输入
    input: (input) => invoke(IPC_CHANNELS.TERMINAL_INPUT, input),
    // 调整终端尺寸（rows/cols）
    resize: (input) => invoke(IPC_CHANNELS.TERMINAL_RESIZE, input),
    // 终止终端会话
    kill: (input) => invoke(IPC_CHANNELS.TERMINAL_KILL, input),
    // 订阅终端创建事件（新终端创建成功时触发）
    subscribeCreatedEvent: (callback) => subscribe(IPC_CHANNELS.TERMINAL_EVENT_CREATED, callback),
    // 订阅终端原始输出事件（含 ANSI 转义序列，未解码，渲染层用 xterm.js 直接 write）
    subscribeOutputEvent: (callback) => subscribe(IPC_CHANNELS.TERMINAL_EVENT_OUTPUT, callback),
    // 订阅终端进程退出事件（exitCode 0 正常退出，非 0 异常退出）
    subscribeExitEvent: (callback) => subscribe(IPC_CHANNELS.TERMINAL_EVENT_EXIT, callback),
  },

  // ── Git 域（Git CLI 封装，请求-响应模式，只读）──────────────
  // 仅支持 status / diff，不提供 commit/push 等写操作
  // （避免误操作主仓库状态，commit/push 由用户在终端手动执行）
  git: {
    // 获取工作区状态（branch/ahead/behind/files）
    status: (input) => invoke(IPC_CHANNELS.GIT_STATUS, input),
    // 获取 diff（unstaged / staged / 对比任意 ref）
    diff: (input) => invoke(IPC_CHANNELS.GIT_DIFF, input),
  },

  // ── 代码库域（codegraph CLI 封装，请求-响应模式）────────────
  // 基于 codegraph CLI 的代码智能查询
  codebase: {
    // 结构化符号搜索（返回符号列表 + 相关度评分）
    query: (input) => invoke(IPC_CHANNELS.CODEBASE_QUERY, input),
    // 区域探索（自然语言查询，返回相关符号源码 + 调用路径 markdown）
    explore: (input) => invoke(IPC_CHANNELS.CODEBASE_EXPLORE, input),
    // 符号详情（符号源码 + 调用链，或文件模式：文件内容 + 依赖）
    node: (input) => invoke(IPC_CHANNELS.CODEBASE_NODE, input),
    // 调用方查询（谁调用了此符号）
    callers: (input) => invoke(IPC_CHANNELS.CODEBASE_CALLERS, input),
    // 被调用方查询（此符号调用了哪些符号）
    callees: (input) => invoke(IPC_CHANNELS.CODEBASE_CALLEES, input),
    // 影响分析（修改此符号会影响哪些代码）
    impact: (input) => invoke(IPC_CHANNELS.CODEBASE_IMPACT, input),
  },

  // ── 工具域（工具系统元数据，请求-响应模式）──────────────────
  // 供渲染层展示工具面板
  tool: {
    // 列出当前已注册的工具清单（含权限级别）
    list: (input) => invoke(IPC_CHANNELS.TOOL_LIST, input),
  },

  // ── Settings 域（API Key 管理 + 遥测级别开关，请求-响应模式）──
  // 主进程通过 safeStorage 加密存储 API Key（Windows DPAPI / macOS Keychain / Linux libsecret）
  // 遥测级别存储在 userData/telemetry-pref.json（明文，非敏感数据）
  settings: {
    // 查询指定提供商的 API Key（未设置时返回 null）
    getApiKey: (input) => invoke(IPC_CHANNELS.SETTINGS_GET_API_KEY, input),
    // 设置 API Key（主进程加密后存储到 keychain）
    setApiKey: (input) => invoke(IPC_CHANNELS.SETTINGS_SET_API_KEY, input),
    // 删除指定提供商的 API Key
    deleteApiKey: (input) => invoke(IPC_CHANNELS.SETTINGS_DELETE_API_KEY, input),
    // 查询遥测级别（off / error-only / full）
    getTelemetryLevel: () => invoke(IPC_CHANNELS.SETTINGS_GET_TELEMETRY_LEVEL),
    // 设置遥测级别（修改后需重启应用生效）
    setTelemetryLevel: (input) => invoke(IPC_CHANNELS.SETTINGS_SET_TELEMETRY_LEVEL, input),
  },

  // ── System 域（运行时可观测性，请求-响应模式）──────────
  // DevPanel 的 Metrics tab + Logs tab 通过此域获取运行时数据
  system: {
    // 查询运行时状态（内存/CPU/uptime/版本），无入参
    getStatus: () => invoke(IPC_CHANNELS.SYSTEM_GET_STATUS),
  },

  // ── Logs 域（日志查看器，请求-响应模式）────────────────
  // 主进程从 main.log 文件尾部按块倒读，避免大文件全量加载
  logs: {
    // 读取最近 N 行日志（入参全可选，默认 200 行不过滤级别）
    read: (input) => invoke(IPC_CHANNELS.LOGS_READ, input),
  },

  // ── DevTools 域（开发者工具集成，请求-响应模式）──────────
  // 打开 Chromium DevTools，主进程调用 webContents.openDevTools({ mode })
  // mode 默认 'detach' 独立窗口；'right'/'bottom' 停靠主窗口
  devtools: {
    // 打开 DevTools（已打开时聚焦原窗口，不会重复打开）
    open: (input) => invoke(IPC_CHANNELS.DEVTOOLS_OPEN, input),
  },

  // ── Dialog 域（原生对话框，请求-响应模式）──────────────────
  // 原生系统对话框封装，当前仅支持目录选择器
  dialog: {
    // 弹出原生目录选择器，返回选中路径或 canceled
    pickDirectory: (input) => invoke(IPC_CHANNELS.DIALOG_PICK_DIRECTORY, input),
  },

  // ── Novel 域（网文写作平台，请求-响应模式）────────────────
  // biome-ignore lint/suspicious/noExplicitAny: novel domain types are flexible
  novel: {
    projectList: (input) => invoke(IPC_CHANNELS.NOVEL_PROJECT_LIST, input),
    projectCreate: (input) => invoke(IPC_CHANNELS.NOVEL_PROJECT_CREATE, input),
    projectGet: (input) => invoke(IPC_CHANNELS.NOVEL_PROJECT_GET, input),
    projectDelete: (input) => invoke(IPC_CHANNELS.NOVEL_PROJECT_DELETE, input),

    chapterList: (input) => invoke(IPC_CHANNELS.NOVEL_CHAPTER_LIST, input),
    chapterGet: (input) => invoke(IPC_CHANNELS.NOVEL_CHAPTER_GET, input),
    chapterSave: (input) => invoke(IPC_CHANNELS.NOVEL_CHAPTER_SAVE, input),
    chapterCreate: (input) => invoke(IPC_CHANNELS.NOVEL_CHAPTER_CREATE, input),
    chapterDelete: (input) => invoke(IPC_CHANNELS.NOVEL_CHAPTER_DELETE, input),

    outlineList: (input) => invoke(IPC_CHANNELS.NOVEL_OUTLINE_LIST, input),
    outlineCreate: (input) => invoke(IPC_CHANNELS.NOVEL_OUTLINE_CREATE, input),
    outlineUpdate: (input) => invoke(IPC_CHANNELS.NOVEL_OUTLINE_UPDATE, input),
    outlineDelete: (input) => invoke(IPC_CHANNELS.NOVEL_OUTLINE_DELETE, input),

    characterList: (input) => invoke(IPC_CHANNELS.NOVEL_CHARACTER_LIST, input),
    characterCreate: (input) => invoke(IPC_CHANNELS.NOVEL_CHARACTER_CREATE, input),
    characterGet: (input) => invoke(IPC_CHANNELS.NOVEL_CHARACTER_GET, input),
    characterUpdate: (input) => invoke(IPC_CHANNELS.NOVEL_CHARACTER_UPDATE, input),
    characterDelete: (input) => invoke(IPC_CHANNELS.NOVEL_CHARACTER_DELETE, input),

    characterRelationshipList: (input) =>
      invoke(IPC_CHANNELS.NOVEL_CHARACTER_RELATIONSHIP_LIST, input),
    characterRelationshipCreate: (input) =>
      invoke(IPC_CHANNELS.NOVEL_CHARACTER_RELATIONSHIP_CREATE, input),
    characterRelationshipDelete: (input) =>
      invoke(IPC_CHANNELS.NOVEL_CHARACTER_RELATIONSHIP_DELETE, input),

    worldSettingList: (input) => invoke(IPC_CHANNELS.NOVEL_WORLD_SETTING_LIST, input),
    worldSettingCreate: (input) => invoke(IPC_CHANNELS.NOVEL_WORLD_SETTING_CREATE, input),
    worldSettingUpdate: (input) => invoke(IPC_CHANNELS.NOVEL_WORLD_SETTING_UPDATE, input),
    worldSettingDelete: (input) => invoke(IPC_CHANNELS.NOVEL_WORLD_SETTING_DELETE, input),

    writingSessionList: (input) => invoke(IPC_CHANNELS.NOVEL_WRITING_SESSION_LIST, input),
    writingSessionCreate: (input) => invoke(IPC_CHANNELS.NOVEL_WRITING_SESSION_CREATE, input),

    exportTxt: (input) => invoke(IPC_CHANNELS.NOVEL_EXPORT_TXT, input),
  },
} satisfies IpcApi;

// 通过 contextBridge 暴露到渲染层的 window.api（contextIsolation: true 下唯一安全方式）
contextBridge.exposeInMainWorld('api', api);
