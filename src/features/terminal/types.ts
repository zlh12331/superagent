/**
 * Terminal feature — 类型定义
 *
 * 终端会话、PTY 输出数据等共享类型。
 */

/** 终端会话 ID（格式：`term-{timestamp}-{random6}`，由 generateTerminalId 生成） */
export type TerminalId = string

/** 后端进程 ID (Tauri 模式下为 PTY 进程 ID；浏览器 mock 模式下为 `mock-` 前缀字符串) */
export type ProcessId = string

/**
 * 终端会话状态机：
 *  - starting: 已创建但后端 PTY 未启动
 *  - running: PTY 运行中，可正常输入输出
 *  - exited: PTY 已正常退出
 *  - error: PTY 启动失败或异常退出
 */
export type TerminalStatus = 'starting' | 'running' | 'exited' | 'error'

/**
 * 终端会话完整描述。
 *
 * 一个 TerminalSession 对应一个 xterm.js 实例和后端 PTY 进程。
 */
export interface TerminalSession {
  /** 唯一会话 ID */
  id: TerminalId
  /** Tab 标题（格式：`{index}: {shell}`） */
  title: string
  /** shell 类型（zsh / bash / cargo / git 等） */
  shell: string
  /** 当前工作目录 */
  cwd: string
  /** 后端进程 ID（null 表示尚未启动） */
  processId: ProcessId | null
  /** 会话状态 */
  status: TerminalStatus
  /** 创建时间戳（ms） */
  createdAt: number
}

/**
 * PTY 输出数据 (来自 command/exec/outputDelta 事件)。
 *
 * 后端将 PTY 的 stdout / stderr 增量推送到前端，
 * TerminalView 通过 onTerminalOutput 监听并写入 xterm 实例。
 */
export interface TerminalOutputDelta {
  /** 输出所属的进程 ID（用于多终端路由） */
  processId: ProcessId
  /** 输出流类型 */
  stream: 'stdout' | 'stderr'
  /** 本次增量数据 */
  data: string
}
