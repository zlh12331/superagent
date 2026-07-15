/**
 * @file 演示场景注入器
 *
 * 负责向对话流注入 mock 消息和审批卡片。
 * 通过 window.dispatchEvent 派发自定义事件 `codex:demo-inject`，
 * 由 ConversationArea 监听并渲染。
 *
 * 设计原则（低耦合）：
 *   DemoPanel 不直接操作 DOM，而是通过事件总线通知 ConversationArea。
 *   DemoPanel 只负责"发事件"，ConversationArea 只负责"收事件并渲染"，
 *   两者互不依赖，可独立测试和替换。
 *
 * ApprovalVariant 类型从 approval-variants.ts 导入（单一数据源），
 * 避免多处定义导致的类型不一致。
 *
 * 参考源码：prototype.html — handleDemoMsg / handleDemoCard /
 *           triggerInlineApproval / handleDemoComprehensive
 */

// ===== 类型导入 =====

/** 从 approval-variants.ts 导入 ApprovalVariant（7种审批变体的单一数据源） */
export type { ApprovalVariant } from './approval-variants'
import type { ApprovalVariant } from './approval-variants'
import { getDemoApprovalPayload } from './approval-variants'

// ===== 类型定义 =====

/**
 * 演示消息类型
 *
 * 对应原型 handleDemoMsg 函数支持的消息场景。
 * 扩展了 recover / complete 用于综合演示中的中断恢复和完成消息。
 */
export type DemoMessageType =
  | 'reasoning' // 推理摘要块（ReasoningSummaryTextDelta）
  | 'plan' // 执行计划块（TurnPlanUpdated）
  | 'rate' // 速率限制横幅（AccountRateLimitsUpdated）
  | 'user-code' // 含代码块的用户消息
  | 'user-attach' // 带附件的用户消息
  | 'user-long' // 长文本用户消息
  | 'user-error' // 含错误日志的用户消息
  | 'interrupted' // 中断消息（用户中断当前生成）
  | 'whitelist' // 白名单提示（已授权命令自动通过）
  | 'recover' // 中断恢复消息（用户恢复已中断的生成）
  | 'complete' // 完成消息（Agent 最终回复总结）

/**
 * 演示卡片类型
 *
 * 对应原型 handleDemoCard 函数支持的工具卡状态。
 * 扩展了 file-change 用于文件变更卡片。
 */
export type DemoCardType =
  | 'tool-running' // 工具执行中（running 状态 + 实时输出）
  | 'tool-error' // 工具错误（error 状态 + 错误详情）
  | 'cmd-error' // 命令错误（非零退出码 + stderr）
  | 'cmd-success' // 命令成功（success + 终端输出）
  | 'multi-tool' // 多工具并行（3 个工具并发执行）
  | 'file-change' // 文件变更卡片（diff 展示）

/**
 * 系统状态类型（用于 DemoPanel 的"系统状态"分组）
 *
 * 对应网络 / 速率限制 / 后端连接等系统级状态演示。
 */
export type SystemStatusType =
  | 'net-online' // 网络状态：在线
  | 'net-offline' // 网络状态：离线
  | 'net-reconnecting' // 网络状态：重连中
  | 'rate-normal' // 速率限制：正常
  | 'rate-limited' // 速率限制：受限
  | 'backend-connected' // 后端连接：已连接
  | 'backend-disconnected' // 后端连接：断开

/**
 * 演示 Toast 类型
 *
 * 对应原型 data-toast 属性的三种 Toast 演示。
 * 仅触发 sonner toast，不派发注入事件（不污染对话流）。
 */
export type DemoToastType =
  | 'success' // 成功 Toast
  | 'error' // 错误 Toast
  | 'warn' // 警告 Toast

/**
 * 注入事件的 payload 结构
 *
 * kind 字段决定本次注入的类型，不同 kind 搭配不同的可选字段：
 * - 'message' → 需提供 messageType
 * - 'card' → 需提供 cardType
 * - 'approval' → 需提供 approvalVariant
 * - 'system-status' → 需提供 systemStatusType
 * - 'comprehensive' → 无需额外字段（综合演示内部自行串联）
 *
 * mockData 字段携带 mock 内容（JSON 字符串），
 * 供 ConversationArea 渲染时使用，避免硬编码在渲染层。
 */
export interface DemoInjectEvent {
  kind: 'message' | 'card' | 'approval' | 'system-status' | 'comprehensive'
  messageType?: DemoMessageType
  cardType?: DemoCardType
  approvalVariant?: ApprovalVariant
  systemStatusType?: SystemStatusType
  /** mock 数据（JSON 字符串），供 ConversationArea 渲染时解析使用 */
  mockData?: string
}

// ===== 事件派发 =====

/** 自定义事件名称 — ConversationArea 通过此名称监听注入事件 */
const DEMO_INJECT_EVENT = 'codex:demo-inject' as const

/**
 * 派发演示注入事件
 *
 * 通过 window.dispatchEvent 广播自定义事件，
 * ConversationArea 监听后根据 payload 中的 kind 和类型字段渲染对应内容。
 *
 * @param payload 注入事件的数据
 */
function dispatchDemoInject(payload: DemoInjectEvent): void {
  window.dispatchEvent(
    new CustomEvent<DemoInjectEvent>(DEMO_INJECT_EVENT, { detail: payload }),
  )
}

// ===== mock 数据生成 =====

/**
 * 各 DemoMessageType 对应的 mock 数据。
 * ConversationArea 可从 mockData 字段解析这些内容进行渲染。
 */
const MESSAGE_MOCK_DATA: Record<DemoMessageType, string> = {
  reasoning: JSON.stringify({
    text: '用户报告了编译错误。我需要先搜索定位问题代码，分析错误原因。',
    duration: '3.2s',
    tokens: 412,
  }),
  plan: JSON.stringify({
    items: [
      { text: '搜索定位编译错误', status: 'active' },
      { text: '分析错误原因并制定方案', status: 'pending' },
      { text: '运行 cargo check 确认编译', status: 'pending' },
      { text: '应用代码修复变更', status: 'pending' },
      { text: '运行测试验证', status: 'pending' },
    ],
  }),
  rate: JSON.stringify({ limit: '35/min', remaining: 3, resetIn: '42s' }),
  'user-code': JSON.stringify({
    text: '编译报错了，帮我看看：',
    code: 'error[E0308]: mismatched types\n  --> src/main.rs:42:10\n   |\n42 |     let x: i32 = "hello";\n   |                ^^^^^^^ expected i32, found &str',
  }),
  'user-attach': JSON.stringify({
    text: '补充一下相关文件：',
    attachments: ['src/main.rs', 'src/lib.rs', 'Cargo.toml'],
  }),
  'user-long': JSON.stringify({
    text: '## 需求描述\n\n我需要实现一个完整的审批流程系统，包含以下功能：\n\n1. **7种审批类型**：command / patch / tool / mcp / perm / dyn / attest\n2. **状态管理**：pending → approved / denied / whitelisted\n3. **UI 差异化**：每种 variant 有独立的 badge 配色和按钮文案\n\n请参考原型设计实现。',
  }),
  'user-error': JSON.stringify({
    text: '运行时报错了：',
    error: 'thread \'main\' panicked at src/bridge.rs:127:\nindex out of bounds: the len is 3 but the index is 5',
  }),
  interrupted: JSON.stringify({ reason: '用户手动中断' }),
  whitelist: JSON.stringify({
    command: 'cargo build',
    message: '已加入白名单，自动执行',
  }),
  recover: JSON.stringify({ message: '已恢复中断的生成' }),
  complete: JSON.stringify({
    text: '综合演示已完成。本次消息流覆盖了用户消息、推理块、计划块、工具卡、审批卡片等全部场景。',
  }),
}

/**
 * 各 DemoCardType 对应的 mock 数据。
 * ConversationArea 可从 mockData 字段解析这些内容进行渲染。
 */
const CARD_MOCK_DATA: Record<DemoCardType, string> = {
  'tool-running': JSON.stringify({
    tool: 'grep_search',
    args: { pattern: 'rpc_request', path: 'src/' },
    output: 'src/bridge.rs:42:pub async fn rpc_request(...)',
  }),
  'tool-error': JSON.stringify({
    tool: 'read_file',
    args: { path: 'src/missing.rs' },
    error: 'File not found: src/missing.rs',
  }),
  'cmd-error': JSON.stringify({
    command: 'cargo check',
    exitCode: 1,
    stderr: 'error[E0308]: mismatched types\n  --> src/main.rs:42:10',
  }),
  'cmd-success': JSON.stringify({
    command: 'cargo nextest run',
    exitCode: 0,
    stdout: 'Running 15 tests...\n15 passed, 0 failed',
  }),
  'multi-tool': JSON.stringify({
    tools: [
      { name: 'grep_search', status: 'success' },
      { name: 'read_file', status: 'success' },
      { name: 'write_file', status: 'running' },
    ],
  }),
  'file-change': JSON.stringify({
    file: 'src-tauri/src/bridge.rs',
    additions: 3,
    deletions: 2,
    diff: [
      { type: 'ctx', text: 'pub async fn rpc_request(' },
      { type: 'del', text: '    request: ClientRequest,' },
      { type: 'add', text: '    request: ClientRequestWrapper,' },
      { type: 'ctx', text: '}' },
    ],
  }),
}

// ===== 便捷函数 =====

/**
 * 注入一条演示消息
 *
 * 派发 kind='message' 事件，ConversationArea 收到后
 * 根据 messageType 渲染对应的推理块 / 计划块 / 用户消息等。
 * 事件 payload 中携带 mockData（JSON 字符串）供渲染层使用。
 *
 * @param type 消息类型（reasoning / plan / rate / user-* / interrupted / whitelist / recover / complete）
 */
export function handleDemoMsg(type: DemoMessageType): void {
  dispatchDemoInject({
    kind: 'message',
    messageType: type,
    mockData: MESSAGE_MOCK_DATA[type],
  })
}

/**
 * 注入一张演示工具卡片
 *
 * 派发 kind='card' 事件后返回 Promise，在 800ms 后 resolve，
 * 模拟工具执行延迟，便于综合演示中按顺序 await 等待每张卡片就绪。
 * 事件 payload 中携带 mockData（JSON 字符串）供渲染层使用。
 *
 * @param type 卡片类型（tool-running / tool-error / cmd-* / multi-tool / file-change）
 * @returns 800ms 后 resolve 的 Promise，模拟工具执行耗时
 */
export function handleDemoCard(type: DemoCardType): Promise<void> {
  dispatchDemoInject({
    kind: 'card',
    cardType: type,
    mockData: CARD_MOCK_DATA[type],
  })
  return new Promise<void>(resolve => {
    setTimeout(resolve, 800)
  })
}

/**
 * 触发内联审批卡片
 *
 * 派发 kind='approval' 事件，ConversationArea 收到后
 * 根据 approvalVariant 渲染对应的审批卡片（命令 / 补丁 / 工具等）。
 * mockData 携带从 getDemoApprovalPayload 生成的 payload JSON。
 *
 * @param variant 审批变体（command / patch / tool / mcp / perm / dyn / attest）
 * @param useWhitelist 是否以白名单模式触发（影响按钮渲染）
 */
export function triggerInlineApproval(
  variant: ApprovalVariant,
  useWhitelist = false
): void {
  dispatchDemoInject({
    kind: 'approval',
    approvalVariant: variant,
    mockData: useWhitelist
      ? JSON.stringify({ ...JSON.parse(getDemoApprovalPayload(variant)), whitelist: true })
      : getDemoApprovalPayload(variant),
  })
}

/**
 * 派发系统状态事件
 *
 * 用于 DemoPanel 的"系统状态"分组按钮，
 * ConversationArea 收到后可渲染对应的系统状态横幅 / 提示。
 *
 * @param type 系统状态类型
 */
export function handleDemoSystemStatus(type: SystemStatusType): void {
  dispatchDemoInject({ kind: 'system-status', systemStatusType: type })
}

/**
 * 触发演示 Toast
 *
 * 对齐原型 data-toast 属性 — 直接调用 sonner toast，
 * 不派发注入事件（Toast 是瞬时反馈，不需要进入对话流）。
 *
 * DemoPanel 层调用此函数后，由 DemoPanel 自身额外 toast.info 提示菜单项已被触发；
 * 因此本函数只负责派发对应级别的 toast 内容，避免重复。
 *
 * @param type Toast 类型（success / error / warn）
 * @param toastImpl sonner 的 toast 函数（由调用方注入，避免本模块硬依赖 sonner）
 */
export function handleDemoToast(
  type: DemoToastType,
  toastImpl: {
    success: (msg: string) => void
    error: (msg: string) => void
    warning: (msg: string) => void
  }
): void {
  switch (type) {
    case 'success':
      toastImpl.success('操作成功反馈演示')
      break
    case 'error':
      toastImpl.error('网络/操作失败演示')
      break
    case 'warn':
      toastImpl.warning('需要注意的提示演示')
      break
  }
}

// ===== 综合演示 =====

/**
 * 延迟工具函数（模拟步骤间间隔）
 *
 * @param ms 延迟毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 综合性消息流演示 — 27步完整流程
 *
 * 按固定顺序串行注入全部消息类型与工具卡状态，
 * 形成一条完整的对话流，覆盖所有演示场景。
 *
 * 流程（参考原型 prototype.html L14049-14460）：
 *   1.  用户消息（含代码块）
 *   2.  推理摘要块
 *   3.  执行计划块
 *   4.  工具卡：执行中
 *   5.  工具卡：错误
 *   6.  命令错误
 *   7.  命令成功
 *   8.  多工具并行
 *   9.  审批卡片：command
 *   10. 审批卡片：patch
 *   11. 审批卡片：tool
 *   12. 审批卡片：mcp
 *   13. 审批卡片：perm
 *   14. 审批卡片：dyn
 *   15. 审批卡片：attest
 *   16. 用户消息：带附件
 *   17. 用户消息：长文本
 *   18. 用户消息：白名单提示
 *   19. 用户消息：错误报告
 *   20. 用户消息：中断
 *   21. 速率限制横幅
 *   22. 文件变更卡片
 *   23. 代码块消息
 *   24. 用户消息：中断恢复
 *   25. 工具卡：成功
 *   26. 审批卡片：command（白名单）
 *   27. 完成消息
 *
 * 每步之间通过 await handleDemoCard / sleep 间隔 800ms，
 * 保证视觉上能看清每一步的状态切换。
 */
export async function handleDemoComprehensive(): Promise<void> {
  // 1. 用户消息：含代码块（报告编译错误）
  handleDemoMsg('user-code')
  await sleep(800)

  // 2. 推理摘要块（Agent 思考过程）
  handleDemoMsg('reasoning')
  await sleep(800)

  // 3. 执行计划块（5步计划）
  handleDemoMsg('plan')
  await sleep(800)

  // 4. 工具卡：执行中（grep_search）
  await handleDemoCard('tool-running')

  // 5. 工具卡：错误（read_file 失败）
  await handleDemoCard('tool-error')

  // 6. 命令错误（cargo check 编译失败）
  await handleDemoCard('cmd-error')

  // 7. 命令成功（cargo nextest 测试通过）
  await handleDemoCard('cmd-success')

  // 8. 多工具并行（3个工具并发）
  await handleDemoCard('multi-tool')

  // 9. 审批卡片：command（命令执行审批）
  triggerInlineApproval('command')
  await sleep(800)

  // 10. 审批卡片：patch（文件变更审批）
  triggerInlineApproval('patch')
  await sleep(800)

  // 11. 审批卡片：tool（工具输入请求）
  triggerInlineApproval('tool')
  await sleep(800)

  // 12. 审批卡片：mcp（MCP Elicitation）
  triggerInlineApproval('mcp')
  await sleep(800)

  // 13. 审批卡片：perm（权限授予审批）
  triggerInlineApproval('perm')
  await sleep(800)

  // 14. 审批卡片：dyn（动态工具调用）
  triggerInlineApproval('dyn')
  await sleep(800)

  // 15. 审批卡片：attest（Attestation 生成）
  triggerInlineApproval('attest')
  await sleep(800)

  // 16. 用户消息：带附件（补充文件）
  handleDemoMsg('user-attach')
  await sleep(800)

  // 17. 用户消息：长文本（详细需求）
  handleDemoMsg('user-long')
  await sleep(800)

  // 18. 用户消息：白名单提示（已授权命令自动通过）
  handleDemoMsg('whitelist')
  await sleep(800)

  // 19. 用户消息：错误报告（粘贴错误堆栈）
  handleDemoMsg('user-error')
  await sleep(800)

  // 20. 用户消息：中断（用户中断当前生成）
  handleDemoMsg('interrupted')
  await sleep(800)

  // 21. 速率限制横幅
  handleDemoMsg('rate')
  await sleep(800)

  // 22. 文件变更卡片（diff 展示）
  await handleDemoCard('file-change')

  // 23. 代码块消息（用户补充代码示例）
  handleDemoMsg('user-code')
  await sleep(800)

  // 24. 用户消息：中断恢复（用户恢复已中断的生成）
  handleDemoMsg('recover')
  await sleep(800)

  // 25. 工具卡：成功（工具执行成功）
  await handleDemoCard('cmd-success')

  // 26. 审批卡片：command（白名单模式 — 自动通过）
  triggerInlineApproval('command', true)
  await sleep(800)

  // 27. 完成消息（Agent 最终回复总结）
  handleDemoMsg('complete')
}
