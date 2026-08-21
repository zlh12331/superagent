# 08 · 渲染进程（React）

> 覆盖：`src/renderer/` —— 入口、路由、组件树、hooks、stores、lib、providers、i18n。

## 1. 入口与启动

- `main.tsx`：React 渲染前**同步**应用主题（`theme-init`）、bootstrap settings（`settings-bootstrap`）、挂载 `<App />`。
- `App.tsx`：组装 `AppErrorBoundary` → `AppProviders`（I18nProvider 最外层 → ThemeProvider → QueryProvider）→ `RouterProvider`。
- `router.tsx`：根布局 `/` + `index`（HomePage）+ `/chat/:sessionId`（ChatPage），lazy 加载。
- `routes/root.tsx`：`RootLayout` 挂 `AppShell` 通过 `<Outlet/>` 渲染首页/聊天页。

## 2. 布局（`components/layout/`）

- **三栏 + 底部 DevPanel**：`AppShell`（主容器，初始化各 bridge hooks + 绑定 DevPanel 会话上下文）、`Sidebar`（会话列表，含搜索、新建、置顶，`thread-item`/`sidebar-account`）、`Topbar`（自绘标题栏，`folder-label`）、`DevPanel`（右面板/底部，tabs：info / diff / file / browser / terminal / dev，配合 `right-panel-panes`）、`loading-list`。
- 布局工具：`sidebar-utils` / `layout-utils`。

## 3. 路由页面

- `home.tsx`：欢迎/空状态页（welcome-store）。
- `chat.tsx`：读取 `sessionId` → `useSessionDetail` → 校验 session/workingDir → 渲染 `ChatPanel` 注入历史消息。

## 4. 组件分区（`components/`）

**chat/**：`ChatPanel`、`ChatInput`、`ChatMessageList`、`message-item`、`Markdown`（shiki 高亮 + DOMPurify 消毒）、`message-actions`、`conversation-search-bar`、`file-change-card`、`streaming-cursor`、`streaming-footer`、`rate-limit-banner`、`message-utils`。

**agent/**：审批 UI——`inline-approval-card`（内联审批卡）、`approval-preview`（预览弹层）、`ask-dialog`（提问框）、`approval-utils`。配合 AI 审批流（见 04/05）。

**file-tree/**：`FileTreePanel`、`FileTreeNode`、`FileViewerPanel`、`file-icon`、`fuzzy-search-dialog`、`inline-create-input`、`file-viewer-utils`。

**git/**：`GitPanel`、`file-list`、`file-diff-view`、`git-panel-parts`、`git-status-utils`。

**terminal/**：`TerminalPanel`、`TerminalTabs`、`TerminalView`（xterm.js + fit）。

**common/**：`ModelSelector`、`CommandPalette`、`UnifiedDiffView`、`EmptyState`、`AsyncBoundary`、`SectionErrorBoundary`、`AppErrorBoundary`、`DialogHost`、`ShortcutHelpDialog`、`UpdateNotice`。

**settings/**：`SettingsDialog` + `sections/`（models/editor/appearance/data/telemetry/mcp/skills/rules-memory/prompt/shortcuts/turns/usage/experimental/approval-mode/relay 等）+ `dialogs/`（add-model、model-config）。

**dev/**：`InspectorPanel`、`MetricsPanel`、`LogsPanel`、`browser-pane`。

**ui/**：Radix 封装（button/dialog/dropdown-menu/select/tooltip/tabs/switch/alert/context-menu/sheet/...）。

## 5. Hooks（`hooks/`）

核心双向桥与数据流：

| Hook | 用途 |
|---|---|
| `use-agent-bridge` / `use-agent` | Agent 会话流桥（run/stop/订阅 part/tool/end），填 transient stores |
| `use-tool-bridge` | 工具进度推送桥 |
| `use-approval-bridge` / `use-approval-mode` | 审批请求/模式桥，驱动审批卡 |
| `use-agent-ask-bridge` | 提问（ask）桥 |
| `use-terminal-bridge` | 终端事件桥 |
| `use-sessions` | 会话列表（TanStack Query） |
| `use-models` / `use-runtime-models` | 模型列表/运行时模型 |
| `use-git` | Git 状态/操作 |
| `use-file-tree` / `use-file-tree-ops` / `use-file-content` / `use-file-write` | 文件树与内容 |
| `use-conversation-search` | 对话内搜索 |
| `use-api-key` / `use-app-info` / `use-system` / `use-update` / `use-telemetry` | 各类状态 |
| `use-async-view` / `use-keyboard-shortcuts` / `use-layout-breakpoint` / `use-protocol-check` | 通用 |

## 6. Stores（`stores/`）

**状态管理分工铁律**：IPC `invoke` server state → TanStack Query；IPC `on` 推送事件 → Zustand。

- `persistent/`：`create-persistent-store`（持久化基座）、`sessions-store`、`settings-store`、`draft-store`、`sidebar-pref-store`。
- `transient/`：`agent-ask-store`、`approvals-store`、`confirm-dialog-store`、`file-tree-store`、`file-viewer-store`、`rate-limit-store`、`reasoning-collapse-store`、`terminal-store`、`tool-store`、`ui-store`、`usage-store`、`welcome-store`。

## 7. lib（`lib/`）

- `ipc.ts`：`window.api` 类型化封装（`use-*` hooks 基座）。
- `agent/ipc-agent-transport.ts`：AI SDK 与主进程 IPC 的传输桥（@ai-sdk/react 接 main）。
- `query/query-client.ts`：TanStack QueryClient 单例。
- `diff/`：`line-diff`（diff-match-patch 分块）+ `unified-diff`（Unified diff 行级计算），供 diff 视图。
- `motion/`：`transitions`（3 缓动曲线 + 4 时长 + 3 spring 预设）+ `variants`（5 单元素 + 3 stagger 容器），与全局 CSS 变量对齐。
- `pending-message.ts`：未发送消息暂存。
- `vim-mode.ts`：输入框 vim 模式。
- `format-time.ts` / `constants.ts` / `error-actions.ts`（错误码 → 操作）/ `utils.ts` / `theme-init.ts` / `settings-bootstrap.ts`。

## 8. Providers（`providers/`）

- `QueryProvider`（TanStack）、`ThemeProvider`（`documentElement.classList` 切双主题，配合 DESIGN.md 令牌）。
- `I18nProvider`（最外层，`react.useSuspense: false`）。

## 9. i18n（`i18n/`）

- 命名空间：`common`（UI 文案）+ `errors`（错误码）。
- 语言检测：`localStorage` → `navigator`；`en` / `zh-CN` 两组。
- `use-translation.ts` 封装；`check:i18n` 脚本卡未翻译 key。

## 10. dev / 测试

- `dev/mock-api.ts`：前端 mock 层，支持脱离主进程独立开发（保留是铁律）。
- `test/`：`msw-handlers`（MSW）、`setup`（jest-dom）、`smoke.test.tsx`、`mock-api.test.ts`。

## 11. 关键文件

- 入口：`main.tsx` / `App.tsx` / `router.tsx` / `routes/root.tsx`
- 布局：`components/layout/AppShell.tsx`、`Sidebar.tsx`、`Topbar.tsx`、`DevPanel.tsx`
- 会话页：`routes/chat.tsx`、`components/chat/ChatPanel.tsx`
- 桥接：`hooks/use-agent-bridge.ts`、`lib/agent/ipc-agent-transport.ts`