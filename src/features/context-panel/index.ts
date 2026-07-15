/**
 * ContextPanel feature — 右侧上下文面板
 *
 * 提供 5 个 tab：信息 / Diff / 文件 / 终端 / 浏览器
 * 对应 prototype.html `<aside class="chat-right-panel">`
 *
 * 参考源码: prototype.html — 搜索 `chat-right-panel`, `crp-tabs`, `crp-pane`
 */

export { ContextPanel, CONTEXT_PANEL_SWITCH_TAB_EVENT } from './ContextPanel'
export type {
  CrpTab,
  ContextPanelSwitchTabDetail,
} from './ContextPanel'
export { InfoPane } from './InfoPane'
export { DiffPane } from './DiffPane'
export { FilesPane } from './FilesPane'
export { BrowserPane } from './BrowserPane'
