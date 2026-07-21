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
//
// 当前包含以下域（Code Agent 架构）：
// - 应用级：app:getStatus / app:openExternal
// - 聊天域（保留兼容旧 chat:send，新业务用 agent 域）：chat:* 系列
// - Agent 域（Code Agent 核心）：agent:run / agent:stop / agent:stream:* / agent:tool:* / agent:approval:*
// - 会话域：session:list / session:get / session:delete / session:rename
// - 文件域：file:read / file:write / file:list / file:watch:start / file:watch:stop / file:watch:event
// - 搜索域：search:grep / search:glob
// - 终端域：terminal:create / terminal:input / terminal:resize / terminal:kill / terminal:event:*
// - Git 域：git:status / git:diff
// - 代码库域：codebase:query / explore / node / callers / callees / impact

/**
 * IPC Channel 常量表
 *
 * 字符串值即协议契约，所有 ipcMain.handle / ipcRenderer.on / webContents.send 必须使用此表的字段，
 * 严禁裸字符串，避免拼写错误导致运行时找不到 handler。
 */
export const IPC_CHANNELS = {
  // ── 应用级 ────────────────────────────────────────
  APP_GET_STATUS: 'app:getStatus',
  APP_OPEN_EXTERNAL: 'app:openExternal',

  // ── 聊天域（Vercel AI SDK v7，保留兼容） ──────────────
  // 请求-响应：渲染层发起对话，返回 sessionId
  CHAT_SEND: 'chat:send',
  // 请求-响应：渲染层中断指定 sessionId 的对话
  CHAT_STOP: 'chat:stop',
  // 流式事件：主进程逐 part 推送 UIMessageStreamPart（文本 chunk / tool 调用 / thinking 等）
  CHAT_STREAM_PART: 'chat:stream:part',
  // 流式事件：流正常结束
  CHAT_STREAM_END: 'chat:stream:end',
  // 流式事件：流异常结束
  CHAT_STREAM_ERROR: 'chat:stream:error',

  // ── Agent 域（Code Agent 核心，支持工具调用） ────────
  // 请求-响应：发起一次 agent 对话，返回 sessionId（自动多轮工具调用直到完成）
  AGENT_RUN: 'agent:run',
  // 请求-响应：中断指定 sessionId 的 agent 对话
  AGENT_STOP: 'agent:stop',
  // 流式事件：主进程逐 part 推送 UIMessageStreamPart（text/tool-call/tool-result/finish 等）
  AGENT_STREAM_PART: 'agent:stream:part',
  // 流式事件：agent 对话正常结束
  AGENT_STREAM_END: 'agent:stream:end',
  // 流式事件：agent 对话异常结束
  AGENT_STREAM_ERROR: 'agent:stream:error',
  // 流式事件：主进程推送工具调用（含入参与权限级别），渲染层展示 UI
  AGENT_TOOL_CALL: 'agent:tool:call',
  // 流式事件：主进程推送工具执行结果（含输出或错误）
  AGENT_TOOL_RESULT: 'agent:tool:result',
  // 流式事件：主进程请求审批（危险操作如写文件、执行命令），等待渲染层响应
  AGENT_APPROVAL_REQUEST: 'agent:approval:request',
  // 请求-响应：渲染层回传审批结果（approve / deny / remember）
  AGENT_APPROVAL_RESPONSE: 'agent:approval:response',

  // ── 工具域（工具系统元数据查询） ──────────────────
  // 请求-响应：列出当前已注册的工具清单（含权限级别，供渲染层展示工具面板）
  TOOL_LIST: 'tool:list',

  // ── 会话域（Code Agent 会话持久化） ────────────────
  // 请求-响应：列出所有会话（分页）
  SESSION_LIST: 'session:list',
  // 请求-响应：获取指定会话的完整消息历史
  SESSION_GET: 'session:get',
  // 请求-响应：删除指定会话
  SESSION_DELETE: 'session:delete',
  // 请求-响应：重命名会话
  SESSION_RENAME: 'session:rename',

  // ── 文件域（文件读写 + 目录列表 + 文件监听） ──────────
  // 请求-响应：读取文件内容（支持大文件分批读取）
  FILE_READ: 'file:read',
  // 请求-响应：写入文件（覆盖或追加）
  FILE_WRITE: 'file:write',
  // 请求-响应：列出目录内容（带深度与隐藏文件过滤）
  FILE_LIST: 'file:list',
  // 请求-响应：开始监听文件变更（返回 watcherId 用于后续 stop）
  FILE_WATCH_START: 'file:watch:start',
  // 请求-响应：停止监听指定 watcher
  FILE_WATCH_STOP: 'file:watch:stop',
  // 流式事件：文件变更事件（chokidar 监听 create/modify/delete/rename）
  FILE_WATCH_EVENT: 'file:watch:event',

  // ── 搜索域（ripgrep + glob） ──────────────────────
  // 请求-响应：正则搜索文件内容（基于 ripgrep）
  SEARCH_GREP: 'search:grep',
  // 请求-响应：按 glob 模式匹配文件路径
  SEARCH_GLOB: 'search:glob',

  // ── 终端域（node-pty 会话池） ─────────────────────
  // 请求-响应：创建终端会话，返回 terminalId
  TERMINAL_CREATE: 'terminal:create',
  // 请求-响应：向终端写入输入
  TERMINAL_INPUT: 'terminal:input',
  // 请求-响应：调整终端尺寸
  TERMINAL_RESIZE: 'terminal:resize',
  // 请求-响应：终止终端会话
  TERMINAL_KILL: 'terminal:kill',
  // 流式事件：终端原始输出（含 ANSI 转义序列）
  TERMINAL_EVENT_OUTPUT: 'terminal:event:output',
  // 流式事件：终端进程退出
  TERMINAL_EVENT_EXIT: 'terminal:event:exit',

  // ── Git 域（Git CLI 封装） ────────────────────────
  // 请求-响应：获取工作区状态（branch/ahead/behind/files）
  GIT_STATUS: 'git:status',
  // 请求-响应：获取 diff（unstaged / staged / 对比任意 ref）
  GIT_DIFF: 'git:diff',

  // ── 代码库域（codegraph CLI 封装，代码智能查询） ───
  // 请求-响应：结构化符号搜索（返回符号列表 + 相关度评分）
  CODEBASE_QUERY: 'codebase:query',
  // 请求-响应：区域探索（自然语言查询，返回相关符号源码 + 调用路径 markdown）
  CODEBASE_EXPLORE: 'codebase:explore',
  // 请求-响应：符号详情（符号源码 + 调用链，或文件模式：文件内容 + 依赖）
  CODEBASE_NODE: 'codebase:node',
  // 请求-响应：调用方查询（谁调用了此符号）
  CODEBASE_CALLERS: 'codebase:callers',
  // 请求-响应：被调用方查询（此符号调用了哪些符号）
  CODEBASE_CALLEES: 'codebase:callees',
  // 请求-响应：影响分析（修改此符号会影响哪些代码）
  CODEBASE_IMPACT: 'codebase:impact',
} as const;

/** IPC Channel 字面量联合类型 */
export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
