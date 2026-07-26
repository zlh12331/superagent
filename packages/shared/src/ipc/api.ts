// packages/shared/src/ipc/api.ts
// IpcApi 接口：window.api 形状定义
// 设计文档 §5.4 类型契约单一来源
//
// Preload 实现 IpcApi，渲染层消费 IpcApi（通过 window.api）
// 全局 Window 接口扩展在此声明，渲染层无需重复声明
//
// 域划分（Code Agent 架构）：
// - app：应用级 API（getStatus / openExternal）
// - chat：聊天域 API（Vercel AI SDK v7，保留兼容；单轮对话走此通道）
// - agent：Code Agent 核心 API（多轮工具调用 + 流式事件 + 审批回传）
// - session：会话持久化 API（基于 SQLite + Drizzle）
// - file：文件读写 API（支持大文件分批 + 文件监听）
// - search：搜索 API（ripgrep + glob）
// - terminal：终端会话 API（node-pty 会话池 + 流式输出）
// - git：Git 操作 API（status / diff）
// - codebase：代码智能 API（codegraph CLI 封装）
// - tool：工具系统元数据 API（tool:list）

import type { IpcEventMap, IpcRequestMap } from './payloads';
import type { IpcResponse } from './response';

/**
 * 提取请求-响应 channel 的方法签名
 *
 * 入参类型：IpcRequestMap[Channel]['req']（void 时省略参数）
 * 返回类型：Promise<IpcResponse<IpcRequestMap[Channel]['res']>>
 */
type IpcInvokeMethod<Channel extends keyof IpcRequestMap> =
  IpcRequestMap[Channel]['req'] extends void
    ? () => Promise<IpcResponse<IpcRequestMap[Channel]['res']>>
    : (input: IpcRequestMap[Channel]['req']) => Promise<IpcResponse<IpcRequestMap[Channel]['res']>>;

/**
 * 提取事件 channel 的订阅方法签名
 *
 * 入参：回调函数，收到 payload 时调用
 * 返回：取消订阅函数（调用后不再接收事件）
 */
type IpcSubscribeMethod<Channel extends keyof IpcEventMap> = (
  callback: (payload: IpcEventMap[Channel]) => void,
) => () => void;

/**
 * IpcApi 接口：window.api 完整形状
 *
 * 每个域包含：
 * - 请求-响应方法（invoke 模式）：通过 ipcRenderer.invoke 调用主进程 handler
 * - 事件订阅方法（subscribe 模式）：通过 ipcRenderer.on 注册监听器，返回 unsubscribe 函数
 *
 * 类型契约：
 * - 所有方法签名从 IpcRequestMap / IpcEventMap 派生，避免手写类型
 * - 请求-响应方法的返回值统一为 Promise<IpcResponse<T>>（discriminated union）
 * - 事件订阅方法的回调参数类型与主进程推送的 payload 严格对齐
 */
export interface IpcApi {
  // ── 应用级 API ──────────────────────────────────────
  /** 应用级 API（health check + 外链打开） */
  app: {
    /** 获取应用运行状态（health check） */
    getStatus: IpcInvokeMethod<'app:getStatus'>;
    /** 通过系统浏览器打开外链 */
    openExternal: IpcInvokeMethod<'app:openExternal'>;
  };

  // ── 聊天域 API（Vercel AI SDK v7，单轮流式） ──────────
  /**
   * 聊天域 API（保留兼容）
   *
   * 单轮流式对话，适用于无工具调用的纯文本对话场景。
   * Code Agent 的多轮工具调用走 agent 域。
   */
  chat: {
    /** 发起对话：传入消息历史，返回 sessionId（渲染层用此 id 订阅后续流式事件） */
    send: IpcInvokeMethod<'chat:send'>;
    /** 中断指定 sessionId 的对话（已结束则返回 stopped=false） */
    stop: IpcInvokeMethod<'chat:stop'>;
    /** 订阅流式 part 事件：每收到一个 UIMessageStreamPart 触发一次回调 */
    subscribePart: IpcSubscribeMethod<'chat:stream:part'>;
    /** 订阅流正常结束事件：所有 part 发送完毕后触发一次 */
    subscribeEnd: IpcSubscribeMethod<'chat:stream:end'>;
    /** 订阅流异常结束事件：发生错误时触发一次（含 code + message） */
    subscribeError: IpcSubscribeMethod<'chat:stream:error'>;
  };

  // ── Agent 域 API（Code Agent 核心，多轮工具调用） ──────
  /**
   * Agent 域 API
   *
   * Code Agent 的核心通信通道，支持：
   * - agent:run 发起对话（多轮工具调用自动循环）
   * - agent:stop 中断指定会话
   * - agent:approval:response 回传审批结果（用户点击批准/拒绝后调用）
   * - agent:stream:* 流式事件订阅（part/end/error）
   * - agent:tool:* 工具调用事件订阅（call/result）
   * - agent:approval:request 审批请求事件订阅（主进程主动推送）
   *
   * 与 chat 域的区别：
   * - chat 域为单轮对话（streamText 一次性返回），不调用工具
   * - agent 域为多轮对话（streamText + tool 循环），支持工具调用 + 审批
   */
  agent: {
    /** 发起 agent 对话：传入消息历史与配置，返回 sessionId */
    run: IpcInvokeMethod<'agent:run'>;
    /** 中断指定 sessionId 的 agent 对话 */
    stop: IpcInvokeMethod<'agent:stop'>;
    /** 回传审批结果：用户点击批准/拒绝后调用，主进程据此 resolve ToolExecutor 的 Promise */
    approvalResponse: IpcInvokeMethod<'agent:approval:response'>;
    /** 订阅流式 part 事件：每收到一个 UIMessageStreamPart（text/tool-call/finish 等）触发一次 */
    subscribeStreamPart: IpcSubscribeMethod<'agent:stream:part'>;
    /** 订阅 agent 对话结束事件：含 reason（completed/aborted/error） */
    subscribeStreamEnd: IpcSubscribeMethod<'agent:stream:end'>;
    /** 订阅 agent 对话异常事件：含 code + message */
    subscribeStreamError: IpcSubscribeMethod<'agent:stream:error'>;
    /** 订阅工具调用事件：主进程推送工具调用入参与权限级别，渲染层展示 UI */
    subscribeToolCall: IpcSubscribeMethod<'agent:tool:call'>;
    /** 订阅工具结果事件：主进程推送工具执行结果（含 output 或 error） */
    subscribeToolResult: IpcSubscribeMethod<'agent:tool:result'>;
    /** 订阅审批请求事件：主进程请求用户审批（permission='ask' 的工具调用） */
    subscribeApprovalRequest: IpcSubscribeMethod<'agent:approval:request'>;
  };

  // ── 会话域 API（SQLite 持久化） ──────────────────────
  /**
   * 会话域 API
   *
   * 通过 SQLite + Drizzle 持久化对话历史。
   * SessionService 提供 list/get/delete/rename 四个 IPC 方法。
   * create/appendMessage 为内部 API（供主进程 AgentService 直接调用），不通过 IPC 暴露。
   */
  session: {
    /** 列出会话（分页查询，按 updatedAt 倒序） */
    list: IpcInvokeMethod<'session:list'>;
    /** 获取指定会话的完整消息历史 */
    get: IpcInvokeMethod<'session:get'>;
    /** 删除指定会话（外键级联删除关联消息） */
    delete: IpcInvokeMethod<'session:delete'>;
    /** 重命名会话标题 */
    rename: IpcInvokeMethod<'session:rename'>;
    /** 创建新会话（绑定 workingDir，空会话），返回 sessionId */
    create: IpcInvokeMethod<'session:create'>;
    /** 查询最近使用的目录列表（去重 + 按 lastUsed 倒序） */
    listRecentDirs: IpcInvokeMethod<'session:listRecentDirs'>;
  };

  // ── 文件域 API（文件读写 + 目录列表 + 文件监听） ────────
  /**
   * 文件域 API
   *
   * 文件读写（支持大文件分批）+ 目录列表 + chokidar 文件监听。
   * 文件监听通过 watcherId 关联，start 返回 id，stop 停止指定 watcher。
   * 文件变更事件通过 subscribeWatchEvent 推送（create/modify/delete/rename）。
   */
  file: {
    /** 读取文件内容（支持分批，避免一次性加载大文件） */
    read: IpcInvokeMethod<'file:read'>;
    /** 写入文件（覆盖或追加） */
    write: IpcInvokeMethod<'file:write'>;
    /** 列出目录内容（带深度与隐藏文件过滤） */
    list: IpcInvokeMethod<'file:list'>;
    /** 开始监听文件变更，返回 watcherId */
    watchStart: IpcInvokeMethod<'file:watch:start'>;
    /** 停止监听指定 watcher */
    watchStop: IpcInvokeMethod<'file:watch:stop'>;
    /** 订阅文件变更事件（create/modify/delete/rename） */
    subscribeWatchEvent: IpcSubscribeMethod<'file:watch:event'>;
    /** 创建新文件（空文件，已存在时报错） */
    create: IpcInvokeMethod<'file:create'>;
    /** 创建新目录（递归创建父目录） */
    createDir: IpcInvokeMethod<'file:createDir'>;
    /** 删除文件或目录（目录递归删除） */
    delete: IpcInvokeMethod<'file:delete'>;
    /** 重命名/移动文件或目录 */
    rename: IpcInvokeMethod<'file:rename'>;
  };

  // ── 搜索域 API（ripgrep + glob） ──────────────────────
  /**
   * 搜索域 API
   *
   * 基于 ripgrep（grep）与 glob 模式的文件内容/路径搜索。
   * 主进程通过子进程调用 ripgrep / 实现 glob 匹配。
   */
  search: {
    /** 正则搜索文件内容（基于 ripgrep） */
    grep: IpcInvokeMethod<'search:grep'>;
    /** 按 glob 模式匹配文件路径 */
    glob: IpcInvokeMethod<'search:glob'>;
  };

  // ── 终端域 API（node-pty 会话池） ─────────────────────
  /**
   * 终端域 API
   *
   * 基于 node-pty 的终端会话池，支持创建多个独立终端。
   * 输出（含 ANSI 转义序列）通过 subscribeOutputEvent 推送，
   * 退出事件通过 subscribeExitEvent 推送（exitCode 0 正常，非 0 异常）。
   */
  terminal: {
    /** 创建终端会话，返回 terminalId */
    create: IpcInvokeMethod<'terminal:create'>;
    /** 向终端写入输入 */
    input: IpcInvokeMethod<'terminal:input'>;
    /** 调整终端尺寸（rows/cols） */
    resize: IpcInvokeMethod<'terminal:resize'>;
    /** 终止终端会话 */
    kill: IpcInvokeMethod<'terminal:kill'>;
    /** 订阅终端创建事件（新终端创建成功时触发，包括 Agent 工具创建的） */
    subscribeCreatedEvent: IpcSubscribeMethod<'terminal:event:created'>;
    /** 订阅终端原始输出事件（含 ANSI 转义序列，未解码） */
    subscribeOutputEvent: IpcSubscribeMethod<'terminal:event:output'>;
    /** 订阅终端进程退出事件 */
    subscribeExitEvent: IpcSubscribeMethod<'terminal:event:exit'>;
  };

  // ── Git 域 API（Git CLI 封装） ────────────────────────
  /**
   * Git 域 API
   *
   * Git CLI 封装，提供工作区状态查询与 diff 获取。
   * 仅支持只读操作（status/diff），不提供 commit/push 等写操作
   * （避免误操作主仓库状态，commit/push 由用户在终端手动执行）。
   */
  git: {
    /** 获取工作区状态（branch/ahead/behind/files） */
    status: IpcInvokeMethod<'git:status'>;
    /** 获取 diff（unstaged / staged / 对比任意 ref） */
    diff: IpcInvokeMethod<'git:diff'>;
  };

  // ── 代码库域 API（codegraph CLI 封装） ────────────────
  /**
   * 代码库域 API
   *
   * 基于 codegraph CLI 的代码智能查询，支持：
   * - 结构化符号搜索（query）
   * - 区域探索（explore，自然语言查询）
   * - 符号详情（node，返回源码 + 调用链）
   * - 调用方查询（callers）/ 被调用方查询（callees）
   * - 影响分析（impact，修改此符号会影响哪些代码）
   */
  codebase: {
    /** 结构化符号搜索（返回符号列表 + 相关度评分） */
    query: IpcInvokeMethod<'codebase:query'>;
    /** 区域探索（自然语言查询，返回相关符号源码 + 调用路径 markdown） */
    explore: IpcInvokeMethod<'codebase:explore'>;
    /** 符号详情（符号源码 + 调用链，或文件模式：文件内容 + 依赖） */
    node: IpcInvokeMethod<'codebase:node'>;
    /** 调用方查询（谁调用了此符号） */
    callers: IpcInvokeMethod<'codebase:callers'>;
    /** 被调用方查询（此符号调用了哪些符号） */
    callees: IpcInvokeMethod<'codebase:callees'>;
    /** 影响分析（修改此符号会影响哪些代码） */
    impact: IpcInvokeMethod<'codebase:impact'>;
  };

  // ── 工具域 API（工具系统元数据） ─────────────────────
  /**
   * 工具域 API
   *
   * 工具系统元数据查询，供渲染层展示工具面板。
   * tool:list 返回当前已注册的工具清单（含权限级别与描述）。
   */
  tool: {
    /** 列出当前已注册的工具清单（含权限级别，供渲染层展示工具面板） */
    list: IpcInvokeMethod<'tool:list'>;
  };

  // ── Settings 域 API（API Key / 敏感数据管理） ────────
  /**
   * Settings 域 API
   *
   * 管理 API Key 等敏感数据，主进程通过 safeStorage 加密存储
   * （Windows DPAPI / macOS Keychain / Linux libsecret）。
   * 渲染层只读写明文，主进程透明加密。
   */
  settings: {
    /** 查询指定提供商的 API Key（未设置时返回 null） */
    getApiKey: IpcInvokeMethod<'settings:getApiKey'>;
    /** 设置 API Key（主进程加密后存储到 keychain） */
    setApiKey: IpcInvokeMethod<'settings:setApiKey'>;
    /** 删除指定提供商的 API Key */
    deleteApiKey: IpcInvokeMethod<'settings:deleteApiKey'>;
    /** 查询遥测级别（off / error-only / full） */
    getTelemetryLevel: IpcInvokeMethod<'settings:getTelemetryLevel'>;
    /** 设置遥测级别（修改后需重启应用生效） */
    setTelemetryLevel: IpcInvokeMethod<'settings:setTelemetryLevel'>;
  };

  // ── System 域 API（运行时可观测性，DevPanel 使用） ─────
  /**
   * System 域 API
   *
   * 运行时可观测性查询，供 DevPanel 的 Metrics tab + Logs tab 使用。
   * - system:getStatus 返回内存/CPU/uptime/版本等运行时指标
   * - logs:read 读取最近 N 行日志（从 main.log 文件尾部倒读）
   */
  system: {
    /** 查询运行时状态（内存/CPU/uptime/版本），无入参 */
    getStatus: IpcInvokeMethod<'system:getStatus'>;
  };

  // ── Logs 域 API（日志查看器，DevPanel 使用） ──────────
  /**
   * Logs 域 API
   *
   * 日志读取接口，供 DevPanel Logs tab 使用。
   * 主进程从 main.log 文件尾部按块倒读，避免大文件全量加载拖慢 IPC。
   */
  logs: {
    /** 读取最近 N 行日志（入参全可选，默认 200 行不过滤级别） */
    read: IpcInvokeMethod<'logs:read'>;
  };

  // ── DevTools 域 API（开发者工具集成，DevPanel Inspector tab 使用） ─
  /**
   * DevTools 域 API
   *
   * 打开 Chromium DevTools（renderer 进程的 Elements/Console/Sources/Network/Performance 等）。
   * 主进程调用 webContents.openDevTools({ mode }) 实现。
   *
   * mode 说明：
   * - 'detach'（默认）：独立窗口，不占用应用主窗口空间
   * - 'right'：停靠在主窗口右侧
   * - 'bottom'：停靠在主窗口底部
   *
   * dev 模式启动时会自动打开一次（detach），用户也可通过 DevPanel Inspector tab 手动唤起。
   */
  devtools: {
    /** 打开 Chromium DevTools（已打开时聚焦原窗口） */
    open: IpcInvokeMethod<'devtools:open'>;
  };

  // ── Dialog 域 API（原生对话框） ─────────────────────
  /**
   * Dialog 域 API
   *
   * 原生系统对话框封装。当前仅支持目录选择器（pickDirectory）。
   * 主进程通过 Electron dialog.showOpenDialog 实现。
   */
  dialog: {
    /** 弹出原生目录选择器，返回选中路径或 canceled */
    pickDirectory: IpcInvokeMethod<'dialog:pickDirectory'>;
  };

  // ── Novel 域 API（网文写作平台） ─────────────────────
  /**
   * Novel 域 API
   *
   * 网文写作平台的所有业务操作，包括项目、章节、大纲、角色、世界观、写作会话等。
   * 所有方法使用 any 类型约束以兼容 strict TS 配置。
   */
  // biome-ignore lint/suspicious/noExplicitAny: novel domain types are flexible
  novel: {
    // 项目管理
    projectList: IpcInvokeMethod<'novel:project:list'>;
    projectCreate: IpcInvokeMethod<'novel:project:create'>;
    projectGet: IpcInvokeMethod<'novel:project:get'>;
    projectDelete: IpcInvokeMethod<'novel:project:delete'>;

    // 章节管理
    chapterList: IpcInvokeMethod<'novel:chapter:list'>;
    chapterGet: IpcInvokeMethod<'novel:chapter:get'>;
    chapterSave: IpcInvokeMethod<'novel:chapter:save'>;
    chapterCreate: IpcInvokeMethod<'novel:chapter:create'>;
    chapterDelete: IpcInvokeMethod<'novel:chapter:delete'>;

    // 大纲管理
    outlineList: IpcInvokeMethod<'novel:outline:list'>;
    outlineCreate: IpcInvokeMethod<'novel:outline:create'>;
    outlineUpdate: IpcInvokeMethod<'novel:outline:update'>;
    outlineDelete: IpcInvokeMethod<'novel:outline:delete'>;

    // 角色管理
    characterList: IpcInvokeMethod<'novel:character:list'>;
    characterCreate: IpcInvokeMethod<'novel:character:create'>;
    characterGet: IpcInvokeMethod<'novel:character:get'>;
    characterUpdate: IpcInvokeMethod<'novel:character:update'>;
    characterDelete: IpcInvokeMethod<'novel:character:delete'>;

    // 角色关系管理
    characterRelationshipList: IpcInvokeMethod<'novel:character:relationship:list'>;
    characterRelationshipCreate: IpcInvokeMethod<'novel:character:relationship:create'>;
    characterRelationshipDelete: IpcInvokeMethod<'novel:character:relationship:delete'>;

    // 世界观管理
    worldSettingList: IpcInvokeMethod<'novel:world-setting:list'>;
    worldSettingCreate: IpcInvokeMethod<'novel:world-setting:create'>;
    worldSettingUpdate: IpcInvokeMethod<'novel:world-setting:update'>;
    worldSettingDelete: IpcInvokeMethod<'novel:world-setting:delete'>;

    // 写作会话管理
    writingSessionList: IpcInvokeMethod<'novel:session:list'>;
    writingSessionCreate: IpcInvokeMethod<'novel:session:create'>;

    // 导出
    exportTxt: IpcInvokeMethod<'novel:export:txt'>;
  };
}

/** 全局 Window 接口扩展（渲染层通过 window.api 访问） */
declare global {
  interface Window {
    api: IpcApi;
  }
}
