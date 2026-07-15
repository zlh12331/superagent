/**
 * Normal 场景 mock 数据
 *
 * 从各 API 文件抽取的 mock 数据集中存放，提供完整的功能开发数据。
 * 包含 8 个线程、2 条消息、4 个 MCP 服务器等，覆盖典型使用场景。
 *
 * ## 工厂函数
 *
 * - createMockThread: 构造新线程（createThread mock 使用）
 * - createMockTurn: 构造新轮次（startTurn mock 使用）
 * - forkMockThread: 分叉线程（forkThread mock 使用）
 *
 * @see src/lib/codex/mock/types.ts — MockData 接口定义
 */

import type { Thread, Turn, ThreadId, ThreadMetadata, UsageStat, ChatStats } from '../../types'
import type { MockData } from '../types'

// ---------------------------------------------------------------------------
// 时间常量（模块加载时计算一次，与原各 API 文件行为一致）
// ---------------------------------------------------------------------------

const NOW = Date.now()
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

// ---------------------------------------------------------------------------
// Thread 域 mock 数据
// ---------------------------------------------------------------------------

/** Thread 默认值（除 id 和 title 外的所有字段） */
const DEFAULT_THREAD: Omit<Thread, 'id' | 'title'> = {
  createdAt: NOW - HOUR,
  updatedAt: NOW - MIN,
  archived: false,
  archivedAt: null,
  appId: null,
  cwd: null,
  forkedFromThreadId: null,
  model: 'gpt-5',
  modelProvider: 'openai',
  metadata: { folder: null, msgs: 0, title: null, pinned: false },
}

/** 线程列表（8 个，含 2 个已归档） */
const threads: Thread[] = [
  makeThread({
    id: '1',
    title: '重构 auth 模块，接入 OAuth 回调',
    createdAt: NOW - HOUR,
    updatedAt: NOW - 2 * MIN,
    cwd: '/Users/dev/codex-rs',
    metadata: { folder: 'codex-rs', msgs: 12, title: null, pinned: false },
  }),
  makeThread({
    id: '2',
    title: '修复 Tauri v2 deep-link 注册失败',
    createdAt: NOW - 2 * HOUR,
    updatedAt: NOW - HOUR,
    cwd: '/Users/dev/superagent',
    metadata: { folder: 'superagent', msgs: 8, title: null, pinned: false },
  }),
  makeThread({
    id: '3',
    title: 'specta 类型生成迁移方案评估',
    // 原型显示"昨天"，createdAt 需早于 updatedAt
    createdAt: NOW - 2 * DAY,
    updatedAt: NOW - DAY,
    cwd: '/Users/dev/codex-rs',
    metadata: { folder: 'codex-rs', msgs: 24, title: null, pinned: false },
  }),
  makeThread({
    id: '4',
    title: '编写 event bridge 单元测试',
    // 原型显示"3天前"
    createdAt: NOW - 4 * DAY,
    updatedAt: NOW - 3 * DAY,
    cwd: '/Users/dev/codex-rs',
    metadata: { folder: 'codex-rs', msgs: 5, title: null, pinned: false },
  }),
  makeThread({
    id: '5',
    title: 'Tailwind v4 CSS-first 配置',
    // 原型显示"5天前"
    createdAt: NOW - 6 * DAY,
    updatedAt: NOW - 5 * DAY,
    cwd: '/Users/dev/superagent',
    metadata: { folder: 'superagent', msgs: 3, title: null, pinned: false },
  }),
  makeThread({
    id: '6',
    title: '重构认证体系（8层递归测试）',
    // 原型显示"刚刚"
    createdAt: NOW - MIN,
    updatedAt: NOW,
    cwd: '/Users/dev/superagent',
    metadata: { folder: 'superagent', msgs: 0, title: null, pinned: false },
  }),
  makeThread({
    id: '7',
    title: 'v0.1 发版前的依赖审计',
    // 原型显示"3周前"
    createdAt: NOW - 22 * DAY,
    updatedAt: NOW - 21 * DAY,
    archived: true,
    archivedAt: NOW - 21 * DAY,
    metadata: { folder: null, msgs: 9, title: null, pinned: false },
  }),
  makeThread({
    id: '8',
    title: '旧版 ts-rs 类型导出脚本',
    // 原型显示"2周前"
    createdAt: NOW - 15 * DAY,
    updatedAt: NOW - 14 * DAY,
    archived: true,
    archivedAt: NOW - 14 * DAY,
    metadata: { folder: null, msgs: 15, title: null, pinned: false },
  }),
]

/**
 * 构造 Thread 对象的工厂函数（内部使用）。
 *
 * 以 DEFAULT_THREAD 为底，合并传入的部分字段，
 * metadata 字段单独合并以避免覆盖。
 */
function makeThread(
  partial: Partial<Thread> & Pick<Thread, 'id' | 'title'>
): Thread {
  return {
    ...DEFAULT_THREAD,
    ...partial,
    metadata: { ...DEFAULT_THREAD.metadata, ...partial.metadata },
  }
}

/**
 * 创建 mock 线程（createThread mock 使用）。
 *
 * @param threadId — 线程 ID（为空时自动生成）
 * @param title — 线程标题（为空时使用"新会话"）
 * @param cwd — 工作目录（影响 metadata.folder）
 * @param metadata — 可选元数据覆盖
 * @returns 新构造的 Thread 对象
 */
export function createMockThread(
  threadId?: string,
  title?: string | null,
  cwd?: string | null,
  metadata?: Partial<ThreadMetadata>
): Thread {
  const folder = cwd?.split('/').pop() ?? null
  return makeThread({
    id: threadId ?? `thread-${Date.now()}`,
    title: title ?? '新会话',
    cwd: cwd ?? null,
    updatedAt: NOW,
    createdAt: NOW,
    metadata: { folder, msgs: 0, title: null, pinned: false, ...metadata },
  })
}

/**
 * 分叉 mock 线程（forkThread mock 使用）。
 *
 * 复制原线程，生成新 ID 和"(副本)"后缀标题。
 *
 * @param original — 原线程
 * @returns 分叉后的新线程
 */
export function forkMockThread(original: Thread): Thread {
  return makeThread({
    ...original,
    id: `thread-${Date.now()}`,
    title: `${original.title} (副本)`,
    forkedFromThreadId: original.id,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

// ---------------------------------------------------------------------------
// Turn 域 mock 数据
// ---------------------------------------------------------------------------

/**
 * mock 消息列表（11 条，含 3 轮用户提问，对齐原型 messages 区域）
 *
 * 完整还原原型 docs/design/prototype.html 的 bridge.rs 调试场景：
 * 第 1 轮：
 *   1. 用户提问 streaming 事件丢失问题
 *   2. 助手响应"先读文件"
 *   3. read_file 工具调用卡片（成功状态）
 *   4. 助手初步分析（确认问题 + 需进一步排查 event_bridge）
 * 第 2 轮：
 *   5. 用户追问 event_bridge 订阅竞态
 *   6. 助手响应"检查并发模型"
 *   7. grep_search 工具调用卡片（成功状态）
 *   8. 助手确认竞态风险 + 给出 drain 建议
 * 第 3 轮：
 *   9. 用户要求写测试验证
 *   10. 助手响应"生成测试用例"
 *   11. exec_command 审批卡片（等待审批状态）
 *
 * P0 修复：补充多轮用户消息（3 条用户消息），还原原型 VerticalProgressBar 多圆点导航交互。
 * 原型逻辑：≥2 条用户消息才显示进度条，圆点数 ≤10。
 *
 * 时间戳递减排列（最新消息在最下方）。
 */
const messages = [
  {
    id: 'msg-1',
    role: 'user' as const,
    content: 'text' as const,
    text: '帮我看下 src-tauri/src/bridge.rs 里 rpc_request 的返回值处理有没有问题，我怀疑 streaming 场景下会丢事件。',
    timestamp: NOW - 3600_000,
  },
  {
    id: 'msg-2',
    role: 'assistant' as const,
    content: 'text' as const,
    text: '我先读一下这个文件。',
    timestamp: NOW - 3590_000,
  },
  {
    id: 'msg-3',
    role: 'assistant' as const,
    content: 'tool_call' as const,
    text: '',
    timestamp: NOW - 3580_000,
    // 对齐原型 .card.tool-card：read_file 读取 bridge.rs 42-88 行
    toolCall: {
      id: 'tc-1',
      name: 'read_file',
      args: { path: 'src-tauri/src/bridge.rs', start: 42, end: 88 },
      status: 'success' as const,
      result: '已读取 src-tauri/src/bridge.rs 第 42-88 行',
      durationMs: 120,
    },
  },
  {
    id: 'msg-4',
    role: 'assistant' as const,
    content: 'text' as const,
    text: '初步看下来，rpc_request 用 await 等待整个 RPC 响应，但 codex 的事件流是推送式的（ServerNotification），不经过 request/response 通道。我需要再确认下 event_bridge 的订阅逻辑。',
    timestamp: NOW - 3570_000,
  },
  {
    id: 'msg-5',
    role: 'user' as const,
    content: 'text' as const,
    text: '好的，那 event_bridge 那边的订阅有没有问题？我看 next_event 是 &mut self，会不会有竞态？',
    timestamp: NOW - 2400_000,
  },
  {
    id: 'msg-6',
    role: 'assistant' as const,
    content: 'text' as const,
    text: '好问题，让我检查一下 event_bridge 的并发模型。',
    timestamp: NOW - 2390_000,
  },
  {
    id: 'msg-7',
    role: 'assistant' as const,
    content: 'tool_call' as const,
    text: '',
    timestamp: NOW - 2380_000,
    toolCall: {
      id: 'tc-2',
      name: 'grep_search',
      args: { pattern: 'next_event', path: 'src-tauri/src/bridge' },
      status: 'success' as const,
      result: '在 event.rs 找到 3 处 next_event 调用',
      durationMs: 85,
    },
  },
  {
    id: 'msg-8',
    role: 'assistant' as const,
    content: 'text' as const,
    text: '确认有竞态风险。next_event(&mut self) 在 tokio::select! 中与 shutdown 信号竞争，如果 shutdown 先就绪，未处理的事件会被丢弃。\n\n建议：在 shutdown 前先 drain 剩余事件，或者用 channel 把事件转发到独立的 task 处理。',
    timestamp: NOW - 2370_000,
  },
  {
    id: 'msg-9',
    role: 'user' as const,
    content: 'text' as const,
    text: '明白了，那帮我写个测试验证一下 shutdown 时事件丢失的场景，用 cargo nextest 跑。',
    timestamp: NOW - 1800_000,
  },
  {
    id: 'msg-10',
    role: 'assistant' as const,
    content: 'text' as const,
    text: '好的，我来生成测试用例并运行。',
    timestamp: NOW - 1790_000,
  },
  {
    id: 'msg-11',
    role: 'assistant' as const,
    content: 'approval' as const,
    text: '',
    timestamp: NOW - 1760_000,
    // 对齐原型 .card.paused：exec_command 等待审批
    approval: {
      requestId: 'req_7f3a9c',
      type: 'command' as const,
      payload: 'cargo nextest run -p superagent --test bridge_spec',
      status: 'pending' as const,
    },
  },
]

/** mock Turn（startTurn 返回的基础 Turn） */
const turn: Turn = {
  id: 'turn-1',
  threadId: 'thread-1',
  status: 'completed',
  startedAt: NOW - 1800_000,
  completedAt: NOW - 1790_000,
}

/**
 * 创建 mock Turn（startTurn mock 使用）。
 *
 * @param threadId — 关联的线程 ID
 * @returns 新构造的 Turn 对象（status 为 running，等待 simulateTurn 推进）
 */
export function createMockTurn(threadId: ThreadId): Turn {
  return {
    id: `turn-${Date.now()}`,
    threadId,
    status: 'running',
    startedAt: Date.now(),
    completedAt: null,
  }
}

// ---------------------------------------------------------------------------
// Account 域 mock 数据
// ---------------------------------------------------------------------------

/**
 * 账户信息 mock 数据
 *
 * 对齐原型侧边栏底部 account-trigger：
 * - uname: "dev"（从 email @ 之前部分提取）
 * - uemail: "api-key · sk-…"（表示使用 API Key 认证模式）
 * - 统计栏 csbAccount: dev@codex.dev
 *
 * authMode 为 'api_key' 对应原型 "api-key" 显示；
 * plan 设为 'PRO'（API 用户套餐，与 ChatGPT Plus 用户区分）。
 */
const account = {
  email: 'dev@codex.dev',
  plan: 'PRO',
  authMode: 'api_key' as const,
}

// ---------------------------------------------------------------------------
// Config 域 mock 数据
// ---------------------------------------------------------------------------

const config = {
  model: 'gpt-5-codex',
  temperature: 0.3,
  maxTokens: 8192,
  approvalMode: 'manual' as const,
  sandbox: true,
}

// ---------------------------------------------------------------------------
// FS 域 mock 数据
// ---------------------------------------------------------------------------

const fileEntries = [
  {
    path: '/src/main.rs',
    name: 'main.rs',
    isDirectory: false,
    size: 1024,
    modifiedAt: NOW - HOUR,
  },
  {
    path: '/src/bridge',
    name: 'bridge',
    isDirectory: true,
    size: 0,
    modifiedAt: NOW - HOUR,
  },
]

const fileTree = {
  name: 'codex-rs',
  path: '/codex-rs',
  type: 'folder' as const,
  children: [
    {
      name: 'core',
      path: '/codex-rs/core',
      type: 'folder' as const,
      children: [
        {
          name: 'src',
          path: '/codex-rs/core/src',
          type: 'folder' as const,
          children: [
            { name: 'lib.rs', path: '/codex-rs/core/src/lib.rs', type: 'file' as const },
            { name: 'session.rs', path: '/codex-rs/core/src/session.rs', type: 'file' as const },
            { name: 'config.rs', path: '/codex-rs/core/src/config.rs', type: 'file' as const },
          ],
        },
        { name: 'Cargo.toml', path: '/codex-rs/core/Cargo.toml', type: 'file' as const },
      ],
    },
    {
      name: 'tui',
      path: '/codex-rs/tui',
      type: 'folder' as const,
      children: [
        {
          name: 'src',
          path: '/codex-rs/tui/src',
          type: 'folder' as const,
          children: [
            { name: 'app.rs', path: '/codex-rs/tui/src/app.rs', type: 'file' as const },
            { name: 'main.rs', path: '/codex-rs/tui/src/main.rs', type: 'file' as const },
          ],
        },
      ],
    },
    { name: 'Cargo.toml', path: '/codex-rs/Cargo.toml', type: 'file' as const },
    { name: 'README.md', path: '/codex-rs/README.md', type: 'file' as const },
  ],
}

const allFiles = [
  { title: 'lib.rs', path: '/codex-rs/core/src/lib.rs', score: 1.0 },
  { title: 'session.rs', path: '/codex-rs/core/src/session.rs', score: 1.0 },
  { title: 'config.rs', path: '/codex-rs/core/src/config.rs', score: 1.0 },
  { title: 'Cargo.toml', path: '/codex-rs/core/Cargo.toml', score: 1.0 },
  { title: 'app.rs', path: '/codex-rs/tui/src/app.rs', score: 1.0 },
  { title: 'main.rs', path: '/codex-rs/tui/src/main.rs', score: 1.0 },
  { title: 'Cargo.toml', path: '/codex-rs/Cargo.toml', score: 1.0 },
  { title: 'README.md', path: '/codex-rs/README.md', score: 1.0 },
]

// ---------------------------------------------------------------------------
// MCP 域 mock 数据
// ---------------------------------------------------------------------------

const mcpServers = [
  {
    id: 'mcp-1',
    name: 'filesystem',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/dev'],
    env: {},
    status: 'connected' as const,
    tools: 12,
    resources: 3,
    error: null,
  },
  {
    id: 'mcp-2',
    name: 'github',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {},
    status: 'connected' as const,
    tools: 28,
    resources: 0,
    error: null,
  },
  {
    id: 'mcp-3',
    name: 'slack',
    transport: 'sse' as const,
    command: null,
    args: [],
    env: {},
    status: 'disconnected' as const,
    tools: 0,
    resources: 0,
    error: null,
  },
  {
    id: 'mcp-4',
    name: 'postgres',
    transport: 'stdio' as const,
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres'],
    env: {},
    status: 'error' as const,
    tools: 0,
    resources: 0,
    error: 'authentication failed',
  },
]

const mcpTools = [
  { serverId: 'mcp-1', name: 'read_file', description: '读取文件内容', inputSchema: { path: 'string' } },
  { serverId: 'mcp-1', name: 'write_file', description: '写入文件内容', inputSchema: { path: 'string', content: 'string' } },
  { serverId: 'mcp-1', name: 'list_directory', description: '列出目录内容', inputSchema: { path: 'string' } },
  { serverId: 'mcp-2', name: 'create_issue', description: '创建 GitHub Issue', inputSchema: { title: 'string', body: 'string' } },
  { serverId: 'mcp-2', name: 'search_repos', description: '搜索仓库', inputSchema: { query: 'string' } },
]

const mcpResources = [
  { serverId: 'mcp-1', uri: 'file:///Users/dev/README.md', name: 'README.md', description: '项目说明文档', mimeType: 'text/markdown' },
  { serverId: 'mcp-1', uri: 'file:///Users/dev/Cargo.toml', name: 'Cargo.toml', description: 'Rust 项目配置', mimeType: 'text/toml' },
]

// ---------------------------------------------------------------------------
// 其他域 mock 数据
// ---------------------------------------------------------------------------

const plugins = [
  { id: 'plugin-1', name: 'git', version: '1.0.0', enabled: true },
]

const processes = [
  {
    pid: 1234,
    name: 'codex',
    command: 'codex --in-process',
    cpuUsage: 1.2,
    memoryUsage: 128 * 1024 * 1024,
  },
]

const commandResult = {
  commandId: 'cmd-1',
  exitCode: 0,
  stdout: 'mock output',
  stderr: '',
  duration: 1200,
}

const realtimeVoices = ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']

// ─── UI 层后端数据 ──────────────────────────────────────────

/**
 * 账户用量统计 mock 数据
 *
 * 模拟 5h/本周/Token 用量等指标，用于 AccountDialog 展示。
 */
const usageStats: UsageStat[] = [
  {
    label: '5h 用量',
    value: '42%',
    sub: '210 / 500',
    progress: 42,
  },
  {
    label: '本周用量',
    value: '68%',
    sub: '1.7k / 2.5k',
    progress: 68,
    warn: true,
  },
  {
    label: 'Token 用量',
    value: '8.2k',
    sub: '/ 200k ctx',
    progress: 4,
  },
  {
    label: '速率限制',
    value: '正常',
    sub: '无限制',
    progress: null,
  },
]

/**
 * 聊天统计栏指标 mock 数据
 *
 * 对齐原型 composer-stats-bar (#composerStatsBar) 的显示值：
 * - #csbRate "5h" → tokenRate（5 小时速率窗口指示）
 * - #csbRateLimit "580 / 1000" → rateLimit（余量 / 总量）
 * - #csbSafetyBuffer 原型隐藏（display:none），保留值供条件显示
 * - #csbModelReroute 原型隐藏（display:none），保留值供条件显示
 *
 * 用于 ChatInput 底部统计栏，Tauri 生产模式下由后端流式通知提供真实数据。
 */
const chatStats: ChatStats = {
  tokenRate: '5h',
  rateLimit: '580 / 1000',
  safetyBufferPercent: 87,
  modelReroute: '→ gpt-4o',
}

// ---------------------------------------------------------------------------
// 导出 normalMockData
// ---------------------------------------------------------------------------

/**
 * Normal 场景的完整 mock 数据
 *
 * 汇总所有 API 文件的 mock 数据，作为 normal 场景的数据源。
 * error 场景也以此为基础数据，仅在 shouldFail 返回 true 时抛错。
 */
export const normalMockData: MockData = {
  threads,
  messages,
  turn,
  // 线程目标 mock 数据 — 仅线程 1 有目标，其他线程无目标（section 不显示）
  // 对齐原型 #crpGoalSection 默认 display:none，仅 API 返回非空 goal 时才显示
  threadGoals: {
    '1': {
      objective: '将 OAuth 回调从 rpc_request 迁移到 event_bridge，保留向后兼容',
      status: 'active',
      tokenBudget: null,
    },
  },
  account,
  config,
  fileEntries,
  fileTree,
  allFiles,
  mcpServers,
  mcpTools,
  mcpResources,
  plugins,
  processes,
  commandResult,
  realtimeVoices,
  usageStats,
  chatStats,
}
