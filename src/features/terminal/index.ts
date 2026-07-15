/**
 * Terminal feature — 多标签终端面板
 *
 * 负责多标签终端（zsh/cargo 等）、标签切换、关闭、
 * 与 codex-rs 命令执行集成。
 *
 * 参考源码: prototype.html — 搜索 `term-tab`, `term-tabs`
 *
 * 组件实现: Task 16
 */

export { TerminalPanel } from './TerminalPanel'
export { TerminalTabs } from './TerminalTabs'
export { TerminalView } from './TerminalView'
export { useTerminalStore } from './terminal-store'
export type { TerminalSession, TerminalId, TerminalStatus } from './types'
