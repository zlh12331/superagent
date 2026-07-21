// src/renderer/stores/index.ts
// 状态管理统一入口（4 层状态架构）
// ──────────────────────────────────────────────────────────────
// 4 层状态架构（符合 Kent C. Dodds 二分法 + TkDodo 推送层补充）：
//
// L1 临时 UI 状态层（useState / useReducer）
//    局部交互、表单临时值。规则：能用 useState 就别上推到 L2/L3/L4。
//    位置：业务组件内，不集中管理。
//
// L2 客户端共享状态层（Zustand）
//    跨组件共享、用户操作产生的状态。分两个子层：
//    - persistent/：跨应用重启保留（sessions / settings）
//    - transient/：运行时态，重启即失（approvals / terminal / editor）
//
// L3 服务端请求状态层（TanStack Query + IPC invoke）
//    请求-响应模型：useQuery(['files'], () => window.api.invoke('files:get'))
//    缓存 + 失效 + 竞态由 TanStack Query 处理。
//    位置：lib/query/ 提供 QueryClient 配置 + Provider。
//
// L4 流式推送状态层（Zustand + IPC on 订阅）
//    主进程持续推送（非请求-响应）：chat part / file-tree 变更 / tool 进度。
//    TanStack Query 不擅长持续推送，用 Zustand 订阅 IPC 事件。
//    位置：server/ 提供 createIpcStreamStore 工厂。
//
// 派生状态层（hooks，按需）
//    跨多个 store 组合时抽 hook（如 useActiveSession = sessions + chat messages）。
//    位置：hooks/ 目录，不集中管理，按需创建。
// ──────────────────────────────────────────────────────────────

export type { SessionMeta } from './persistent/sessions-store';
// L2 客户端共享状态层 - persistent（跨重启保留）
// - useActiveSessionStore：激活会话 id（UI 状态，持久化到 localStorage）
// - useSessionsStore：兼容别名（指向 useActiveSessionStore，便于渐进式重构）
//   sessions 列表数据已迁移到 TanStack Query（见 hooks/use-sessions.ts）
export { useActiveSessionStore, useSessionsStore } from './persistent/sessions-store';
export type { AiSettings, EditorSettings, Theme } from './persistent/settings-store';
export { useSettingsStore } from './persistent/settings-store';
export type {
  ApprovalItem,
  ApprovalStatus,
  ApprovalType,
} from './transient/approvals-store';
// L2 客户端共享状态层 - transient（运行时态）
export { useApprovalsStore } from './transient/approvals-store';
export type { TerminalMeta } from './transient/terminal-store';
export { useTerminalStore } from './transient/terminal-store';
export type {
  ToolCallError,
  ToolCallItem,
  ToolCallStatus,
  ToolPermission,
} from './transient/tool-store';
// L2 客户端共享状态层 - transient（工具调用运行时态）
// 实际属于 L4 流式推送层：IPC on 订阅 agent:tool:call / agent:tool:result
export { useToolStore } from './transient/tool-store';

// L3 服务端请求状态层
// （TanStack Query Provider 在 providers/QueryProvider.tsx，
//   useQuery 直接在业务 hook 中使用，不集中导出）

export type { IpcSubscriber, StreamReducer } from './server/create-ipc-stream-store';
// L4 流式推送状态层
export {
  accumulateReducer,
  createIpcStreamStore,
  replaceReducer,
} from './server/create-ipc-stream-store';
