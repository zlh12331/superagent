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

**chat/**：`ChatPanel`、`ChatInput`、`ChatMessageList`、`message-item`、`Markdown`（shiki 高亮 + DOMPurify 消毒）、`message-actions`、`GoalBar`（会话目标栏）、`tool-call-view`、`conversation-search-bar`、`file-change-card`、`streaming-cursor`、`streaming-footer`、`rate-limit-banner`、`attachments(-chips)`（附件链路）、`slash-commands` / `slash-suggest-panel`（斜杠命令）、`question-jump-bar`、`chat-status-bar`、`panel-notice`；composer 拆分 hooks（`use-composer-*` 五件）+ `use-vim-mode` / `use-message-nav-rail` / `use-auto-compact` / `use-session-compact` / `use-mention-files` / `use-chat-goals`。

**agent/**：审批 UI——`inline-approval-card`（内联审批卡）、`approval-preview`（预览弹层）、`ask-dialog`（提问框）、`approval-utils`。配合 AI 审批流（见 04/05）。

**browser/**：`browser-pane`（WebContentsView 承载壳）、`browser-toolbar`、`browser-device-bar`、`browser-url`、`browser-geometry`、`use-browser-viewport`——右面板浏览器视图（主进程 preview-service 配套）。

**file-tree/**：`FileTreePanel`、`FileTreeNode`、`FileViewerPanel`、`file-icon`、`fuzzy-search-dialog`、`inline-create-input`、`indent`、`file-viewer-utils`。

**git/**：`GitPanel`、`file-list`、`file-diff-view`、`git-panel-parts`、`git-status-utils`。

**terminal/**：`TerminalPanel`、`TerminalTabs`、`TerminalView`（xterm.js + fit）。

**common/**：`ModelSelector`、`CommandPalette`、`UnifiedDiffView`、`EmptyState`、`AsyncBoundary`、`AsyncSection`、`SectionErrorBoundary`、`AppErrorBoundary`、`DialogHost`、`ShortcutHelpDialog`、`UpdateNotice`、`BrandMark`、`MotionReveal`。

**settings/**：`SettingsDialog`（5 组 16 项导航）+ `sections/`（models / general / proxy / mobile / browser / workspace / terminal / shortcuts / rules-memory / approval-mode / mcp / skills / beta(experimental) / about + 内存面板 `memory-panel` / 通知 `notification-section` / 缩放 `zoom-section` / 备份 `backup-block` / IM 渠道 `im-channels-section` / 远程控制 `remote-control-section` 等）+ `dialogs/`（add-model、model-config）。

**dev/**：`InspectorPanel`、`MetricsPanel`（+ `metrics-format`）、`LogsPanel`。浏览器视图已独立到 `browser/`。

**loading-ui/**：`terminal.tsx`（终端创建中动画）。

**ui/**：Radix 封装 23 个（button/dialog/dropdown-menu/select/tooltip/tabs/switch/alert-dialog/context-menu/sheet/toggle-group/sonner/...）。

## 5. Hooks（`hooks/`）

核心双向桥与数据流：

| Hook | 用途 |
|---|---|
| `use-agent-bridge` / `use-agent` | Agent 会话流桥（run/stop/订阅 part/tool/end），填 transient stores |
| `use-tool-bridge` | 工具进度推送桥 |
| `use-approval-bridge` / `use-approval-mode` | 审批请求/模式桥，驱动审批卡 |
| `use-agent-ask-bridge` | 提问（ask）桥 |
| `use-terminal-bridge` | 终端事件桥 |
| `use-invalidation-bridge` | 31 号失效域订阅（主进程推送 → 按域失效 Query） |
| `use-settings-bridge` / `use-update-bridge` / `use-deep-link` | 设置写穿透回执 / 更新事件 / 深链接桥 |
| `use-sessions` / `use-session-turns` | 会话列表 / 回合分页（TanStack Query） |
| `use-models` / `use-runtime-models` | 模型列表/运行时模型 |
| `use-git` | Git 状态/操作 |
| `use-backups` | 备份恢复点（37 号 B） |
| `use-file-tree` / `use-file-tree-ops` / `use-file-content` / `use-file-write` / `use-file-glob-search` | 文件树与内容 |
| `use-conversation-search` | 对话内搜索 |
| `use-working-dir` / `use-remote-control` / `use-zoom-effect`（35 号） | 工作目录 / 远程控制 / 界面缩放 |
| `use-api-key` / `use-app-info` / `use-system` / `use-update` / `use-install-update` / `use-telemetry` | 各类状态 |
| `use-async-view` / `use-keyboard-shortcuts` / `use-layout-breakpoint` / `use-resizable-panels` / `use-protocol-check` / `use-copy` / `use-mutation-error` / `use-sidebar-highlight` / `use-editor-code-style` | 通用 |

## 6. Stores（`stores/`）

**状态管理分工铁律**：IPC `invoke` server state → TanStack Query；IPC `on` 推送事件 → Zustand。

- `persistent/`：`create-persistent-store`（持久化基座）、`sessions-store`、`settings-store`、`draft-store`、`sidebar-pref-store`。
- `transient/`（2026-09-30 实测 14 个）：`agent-ask-store`、`agent-run-store`、`approvals-store`、`confirm-dialog-store`、`file-tree-store`、`file-viewer-store`、`pending-message-store`、`rate-limit-store`、`reasoning-collapse-store`、`terminal-store`、`tool-store`、`ui-store`、`update-store`、`welcome-store`。

## 7. lib（`lib/`）

- `ipc.ts`：`window.api` 类型化封装（`unwrap()` 单一出口）。
- `agent/`：`ipc-agent-transport.ts`（AI SDK 与主进程 IPC 的传输桥）+ `stream-chunk-batcher` + `agent-actions`。
- `query/`：`query-client.ts`（TanStack QueryClient 单例）+ `keys.ts`（**queryKey 常量单一归属**——禁组件内联定义 key 的依据）。
- `diff/`：`line-diff`（diff-match-patch 分块）+ `unified-diff`（Unified diff 行级计算）+ `diff-rows`，供 diff 视图。
- `motion/`：`transitions`（3 缓动曲线 + 4 时长 + 3 spring 预设）+ `variants`（5 单元素 + 3 stagger 容器），与全局 CSS 变量对齐。
- `pending-message.ts`：未发送消息暂存（读取即移除，幂等）。
- `settings-ops.ts`：设置/代理/MCP/备份等 IPC 动作封装（组件不直连 window.api 的桥接层）。
- `shortcut-conflicts.ts`：快捷键冲突判定纯函数（自定义键归一化 + 固定键抢占）。
- `invalidation.ts`：31 号失效域的渲染层注册表。
- `vim-mode.ts`：输入框 vim 模式。
- `error-report.ts`（渲染层错误单一出口，electron-log 转发主进程）/ `error-actions.ts`（错误码 → 恢复动作）/ `highlight.ts`（shiki 按需加载）/ `format-bytes.ts` / `format-intl.ts` / `format-time.ts` / `zoom.ts`（35 号档位纯函数）/ `working-dir.ts` / `theme-init.ts` / `settings-bootstrap.ts` / `browser-actions.ts` / `task-actions.ts` / `terminal-actions.ts` / `file-search.ts` 等。

## 8. Providers（`providers/`）

- `QueryProvider`（TanStack）+ `query-devtools.tsx`（React Query devtools，DEV 限定不进产物——`check:devtools` 门禁）。
- `ThemeProvider`（`documentElement.classList` 切双主题，配合 DESIGN.md 令牌）。
- `I18nProvider`（最外层，`useSuspense: false`——资源已打包无需 Suspense）。

## 9. i18n（`i18n/`）

- 命名空间：`common`（UI 文案）+ `errors`（错误码）；语言包按目录拆分（`locales/<lang>/common.json` + `errors.json`）。
- 语言检测：`localStorage`（LanguageDetector 持久化 `code-agent:lang`）→ `navigator`；`en` / `zh-CN` 两组。语言切换经 settings-store 写穿透 SQLite（渲染层刷新后由启动快照恢复）。
- `use-translation.ts` 封装（含 `useErrorMessage` 兜底链）；`check:i18n --strict` 卡缺失/冗余/双语不一致/JSX 硬编码中文。

## 10. dev / 测试

- `dev/`：`mock-api.ts`（前端 mock 层，浏览器 dev 模式 `pnpm dev:web` 用，支持脱离主进程独立开发；保留是铁律）+ `mock-data.ts` / `mock-turns.ts`（mock 数据源）。
- `test/`：`mock-responses.ts`（IPC 响应桩）、`setup.ts`（jest-dom + ResizeObserver/matchMedia polyfill）、`setup-lang.ts`、`smoke.test.tsx`、`mock-api.test.ts`。

## 11. 关键文件

- 入口：`main.tsx` / `App.tsx` / `router.tsx` / `routes/root.tsx`
- 布局：`components/layout/AppShell.tsx`、`Sidebar.tsx`、`Topbar.tsx`、`DevPanel.tsx`
- 会话页：`routes/chat.tsx`、`components/chat/ChatPanel.tsx`
- 桥接：`hooks/use-agent-bridge.ts`、`lib/agent/ipc-agent-transport.ts`