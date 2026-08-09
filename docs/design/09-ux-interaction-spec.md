# 前端交互与数据链路规格说明（09）

> 依据 `src/renderer/` 全部代码 + `src/main/ipc/*` + `packages/shared/src/ipc/meta.ts` 逐文件核实整理
> 整理时间：2026-08-09 ｜ 覆盖：页面布局 / 组件状态与事件 / 交互流程 / 数据链路 / 逐文件完整性
> 诚实原则：所有条目均来自实际代码；不存在的功能标注"占位 / 部分实现 / 不适用"，绝不编造。

## 0. 文档定位说明

### 0.1 与现有设计文档的分工

| 文档 | 视角 | 回答的问题 |
|---|---|---|
| `04-interface-design.md` | 主进程/契约 | IPC 通道清单（74 通道）、preload `window.api` 形状、zod schema——**接口长什么样** |
| `05-functional-design.md` | 需求/设计意图 | 按功能域描述需求、模块职责、设计决策——**产品想要什么** |
| `03-directory-structure.md` | 工程组织 | 目录分层与命名约定——**代码放在哪** |
| **本文档（09）** | **渲染层实现态** | 每个页面怎么排布、每个组件有哪些状态/事件/转换、每个功能从点击到数据落库的完整链路——**实际是怎么跑的** |

一句话：04 讲 IPC 契约，05 讲功能设计，本文讲"渲染层代码当前的真实行为"（实现态说明书）。凡与 05 冲突之处，以本文（= 代码）为准，冲突点均显式标注。

### 0.2 候选文件名（待确认）

1. **`09-ux-interaction-spec.md`（本文当前名，推荐）**——UX 交互规格：布局 + 状态机 + 流程 + 数据链路
2. `09-frontend-interaction-dataflow.md`——强调交互与数据流双主线
3. `09-frontend-system-manual.md`——"前端系统说明书"风格

> 旧 `08-ux-guidelines.md`（风格指南）未删除，是否保留/重命名/删除由你确认。

### 0.3 阅读约定

- 状态分层代称：**L1** 组件内 useState ｜ **L2** Zustand（persistent/ 跨重启、transient/ 会话内）｜ **L3** TanStack Query ｜ **L4** IPC 事件推送（subscribe → 写 L2 store）
- IPC 通道名一律引用 [meta.ts](../../packages/shared/src/ipc/meta.ts)（25 域，单一真源）
- 主进程服务由 [service-container.ts](../../src/main/service-container.ts) 统一持有（Agent/Chat/File/Search/Terminal/Git/Codebase/Session/MCP/Permission/IM/Update…），dispose 顺序按反向依赖
- 渲染层入口链：`main.tsx → App → AppErrorBoundary → AppProviders(I18n→Theme→Query→Tooltip→Toaster) → RouterProvider`

---

## 一、页面布局

### 1.1 全局布局框架（AppShell）

实现：[AppShell.tsx](../../src/renderer/components/layout/AppShell.tsx) + [globals.css](../../src/renderer/styles/globals.css) `.view-chat`

```
┌──────────────── topbar 52px（--topbar-h，玻璃质感）────────────────┐
├─────────┬───┬───────────────────────┬───┬─────────────────────────┤
│ sidebar │ R │  main（thread-bg）    │ R │   right-panel           │
│ clamp   │ 6 │  HomePage / ChatPage  │ 6 │   DevPanel（6 tab）     │
│ 200-400 │px │  （welcome-mode 时    │px │   clamp 260-360         │
│ (17vw)  │   │   居中 flex 布局）    │   │   (22vw)                │
└─────────┴───┴───────────────────────┴───┴─────────────────────────┘
   R = resizer（可拖拽分隔线，tabIndex=0 + aria-valuenow）
```

- **栅格**：`.app` 两行（topbar + body）；`.view-chat` 五列 grid（sidebar｜resizer｜main｜resizer｜right-panel）；宽度默认 `clamp()` 响应式，拖拽后由 JS 写入 CSS 变量 `--aurora-sidebar-w` / `--aurora-right-panel-w` 覆盖。
- **拖拽范围**：侧栏 [200, 400]px（`SIDEBAR_WIDTH_MIN/MAX`）、右面板 [260, 360]px（`RIGHT_PANEL_WIDTH_MIN/MAX`），见 [layout-utils.ts](../../src/renderer/components/layout/layout-utils.ts)。
- **折叠态**：`sb-collapsed` / `crp-collapsed` 类使 grid 列塌缩为 0；入口在顶栏两按钮 + 右面板竖条 `crp-collapse-btn`。
- **断点联动**：`useLayoutBreakpoint` 监听两档媒体查询——<1200px 自动折叠右面板（`isCompact`）、<900px 自动折叠侧栏（`isNarrow`）；**用户手动切换后（manualRef 置位）断点不再覆盖手动意图**。
- **滚动区域**：主内容 `main#main-content`（供"跳过导航"锚点）、侧栏列表区、右面板内容区各自独立 `overflow`；主区无滚动条（子组件内部滚动）。
- **欢迎页模式**：`welcome-mode` class 下右面板与右 resizer 隐藏，主区改居中 flex。
- **窗口控件避让**：设置页头部右侧预留 140px `app-region-drag` 透明拖拽区，不遮挡系统关闭/最小化按钮；Topbar 由系统标题栏 overlay 承载（`titleBarOverlay`，见主进程 window 配置）。
- **z-index 档位**：dropdown 50 < context-menu 100 < modal-backdrop 1000 < drawer 1500 < modal 2000 < toast 10000 < overlay 15000（命令面板/设置 Sheet）< toast-stack 20000 < boundary 30000（错误边界/调试面板）。新增浮层必须复用档位。

### 1.2 欢迎页（`/`）

实现：[home.tsx](../../src/renderer/routes/home.tsx)（懒加载，路由 index）

```
┌──────────────────────── 主区（居中，max-width 720px）────────────────────────┐
│  welcome-view：品牌大字 ⟨/⟩ Code with TRAE                                  │
│  ┌────────────────────────── composer ──────────────────────────┐           │
│  │  ChatInput（透明背景）                                        │           │
│  │  composer-project-bar：[📁 项目名 ▾]  [模型选择器]            │           │
│  └──────────────────────────────────────────────────────────────┘           │
│  welcome-quick-actions：4 个快捷 pill（应用开发/项目理解/点子/工具知识）       │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 四层结构：welcome-view（品牌）+ composer（输入舱 + project-bar）+ quick-actions；welcome-mode 之外默认隐藏。
- folder dropdown：历史目录列表（相对时间）+「未选择项目」+「浏览其他目录…」（原生选择器）；无历史目录时显示空态文案。
- 空态：无历史目录 → `fdm-empty` 文案；发送时无 workingDir → toast + 自动展开 dropdown。

### 1.3 聊天主页面（`/chat/:sessionId`）

实现：[chat.tsx](../../src/renderer/routes/chat.tsx) + [ChatPanel.tsx](../../src/renderer/components/chat/ChatPanel.tsx)

```
┌ thread-status-bar：项目 basename · [🔍] · 状态点+状态字 · token 用量 ┐
├ 限流横幅（RateLimitBanner，429 时）／ 中断提示条（崩溃恢复）／ 内联审批卡 ┤
├ 会话内搜索栏（ConversationSearchBar，打开时）                         ┤
├ 消息列表（滚动区 + 导航轨 ≥4 条 + scroll-to-bottom 按钮）             ┤
├ footer.composer：ChatInput + composer-project-bar + composer-stats-bar ┤
└  stats-bar：状态 · 消息数 · Token                                       ┘
```

- 路由守卫：`sessionId` 缺失 → 重定向首页；`useSessionDetail` loading → 居中"加载中"；会话不存在 → 重定向首页；`workingDir === ''` → "会话加载异常"错误态。
- `interrupted={lastRunStatus === 'interrupted'}` 驱动顶部 amber 中断提示条（可关闭，会话内不重复）。
- 状态条 `role="status"`：`READY / RUNNING / THINKING / ERROR / IDLE`（流式时 accent 色 + 脉冲点）；token 用量悬浮显示 input/output/total 明细。

### 1.4 设置全屏页

实现：[SettingsDialog.tsx](../../src/renderer/components/settings/SettingsDialog.tsx)

```
┌ 头部：[← 返回]  ⚙ 设置 · 描述    （右 140px 拖拽避让区）           ┐
├ 左导航 160px（5 组 15 项，tablist + ↑↓ 循环） │ 右内容区（滚动）   ┤
└ 组：账户与通用 / 能力 / 智能与行为 / 实验 / 关于                      ┘
```

- 分区：账号(占位)/用量/通用/移动端(占位+IM)/模型服务/MCP/技能/插件(占位)/hooks(占位)/浏览器(说明页)/工作树/命令(占位)/规则与记忆/实验/关于。
- 打开时重置到「模型服务」分区；每个 pane 独立 SectionErrorBoundary。
- 默认分区 `models`；导航激活态 = accent 2px 左竖条 + `text-foreground font-medium`。

### 1.5 右面板（DevPanel）

实现：[DevPanel.tsx](../../src/renderer/components/layout/DevPanel.tsx) + [right-panel-panes.tsx](../../src/renderer/components/layout/right-panel-panes.tsx)

```
┌ 标题栏：6 tab 均分（会话详情/文件变更/文件/浏览器/终端/开发者）┐
├ 内容区（懒加载：终端 xterm ~200KB、浏览器 iframe 切到才加载） ┤
└ 开发者 tab 内再分 4 子视图：Git / 日志 / 指标 / 检查器          ┘
```

- 会话详情 InfoPane：目标列表（goal:list + 清除 ×）、计划待办（task:list）、引用文件（read_file 调用去重）。
- 文件变更 DiffPane：tool-store 中 edit_file/write_file 记录 → UnifiedDiffView 双栏。
- 文件 FilesPane：最近修改文件 → 点击开 FileViewerDialog。
- 终端 TerminalPanel：每会话一个 PTY；输出直写 xterm；退出后保留输出标「已结束」。
- 开发者子视图：GitPanel（只读）、LogsPanel（级别过滤 + 行数 + 刷新）、MetricsPanel（10s 自动刷新）、InspectorPanel（DevTools 三种停靠模式）。
- 空态：Git 干净 →「无变更」；浏览器未加载 URL → 提示输入地址；日志/指标无数据 → 骨架。

### 1.6 文件树面板（侧栏视图）

实现：[FileTreePanel.tsx](../../src/renderer/components/file-tree/FileTreePanel.tsx) + [FileTreeNode.tsx](../../src/renderer/components/file-tree/FileTreeNode.tsx)

```
┌ 头部：[← 返回] 文件树  [🔄 刷新]            ┐
├ 工具栏：[新建文件] [新建目录]（root 下）      ┤
├ 树：目录（▸ 展开箭头 + 图标 + 名称）         ├
│     文件（📄 名称，点击打开查看器）           │
└ 节点 hover 显示 [⋯ 更多]（新建/重命名/删除/复制路径） ┘
```

- 无激活会话 → 空态（"未选择项目"）；rootPath 未就绪 → "加载中"。
- 内联编辑：新建/重命名以行内 input 替换名称（Enter 提交 / Esc 取消 / blur 提交）。
- 查看器内还有轻量只读导航 FileTreeNavigator（react-arborist，受控 data + onToggle 懒加载）。

### 1.7 文件查看器对话框（FileViewerDialog）

实现：[FileViewerDialog.tsx](../../src/renderer/components/file-tree/FileViewerDialog.tsx)

```
┌ 头部：路径面包屑 · 行数 · [复制] [编辑/保存] [关闭] ┐
├ 主体：只读 = shiki 高亮；编辑 = textarea 透明 + shiki 叠加高亮 ┤
└ 左侧（可选）：FileTreeNavigator 轻量导航                    ┘
```

- 状态：只读 / 编辑；脏数据（isDirty）时关闭需确认；`Ctrl+S` 保存。
- 打开/关闭受控于 file-viewer-store（open + filePath + 编辑态 + 内容缓存，卸载不丢）。

### 1.8 命令面板（CommandPalette）

实现：[CommandPalette.tsx](../../src/renderer/components/common/CommandPalette.tsx)

```
┌ palette-overlay（z-overlay 15000，点击遮罩关闭）┐
├ [🔍 输入]                                        ├
├ 分组结果：操作 / 文件(≤50) / 会话(≤20)           ├
├ 空结果：无匹配结果                               ├
└ 底部 kbd 提示：↑↓ 导航 · ⏎ 选择 · esc 关闭       ┘
```

### 1.9 快捷键帮助对话框（ShortcutHelpDialog）

实现：[ShortcutHelpDialog.tsx](../../src/renderer/components/common/ShortcutHelpDialog.tsx)：Dialog + 双列网格（kbd + 描述，11 项）。

### 1.10 Agent 提问对话框（AskDialog）

实现：[ask-dialog.tsx](../../src/renderer/components/agent/ask-dialog.tsx)：展示 Agent 提出的问题（可带单选/多选预置选项 + 自由文本输入）→ 回传 `agent:ask:respond`；取消回传空回答；浏览器模式直接关闭。**注意：独立的"审批对话框"已不存在**（AppShell 注释明确：移除 ApprovalDialog，审批改为内联卡，避免双 UI）。

### 1.11 内联审批卡片（InlineApprovalCard）

实现：[inline-approval-card.tsx](../../src/renderer/components/agent/inline-approval-card.tsx)：渲染在消息列表上方（`role="alert"`，左色条边）；pending 显示三按钮（拒绝/白名单/批准），已决显示状态徽章。

### 1.12 全局浮层清单

| 浮层 | 挂载点 | 控制 |
|---|---|---|
| SettingsDialog | AppShell 根 | ui-store.settingsOpen（顶栏/快捷键/命令面板/错误动作共用） |
| CommandPalette | AppShell 根 | ui-store.paletteOpen（多入口集中） |
| FileViewerDialog | AppShell 根 | file-viewer-store |
| AskDialog | AppShell 根 | agent-ask-store |
| ShortcutHelpDialog | AppShell 根 | 本地 useState（'?' 触发） |
| UpdateNotice | AppShell 根 | 事件驱动 toast，无 DOM |
| Toaster | providers 最内层 | sonner，全局 |

---

## 二、组件状态与事件

### 2.1 AsyncBoundary 五态契约（全局异步约定）

实现：[AsyncBoundary.tsx](../../src/renderer/components/common/AsyncBoundary.tsx) + [use-async-view.ts](../../src/renderer/hooks/use-async-view.ts)

| 状态 | 触发条件 | 渲染 | 可触发事件 |
|---|---|---|---|
| loading | 首载无数据 | 骨架屏（>200ms 才显示防闪烁） | — |
| refreshing | 已有数据 + 后台刷新 | 旧数据 + 顶部细进度条 | — |
| error | query 抛错（`[CODE] msg` 约定） | 本地化文案 + 重试按钮（+ 错误码恢复动作，如「去配置」） | 点击重试 → retry() → loading/refreshing；点击恢复动作 → openSettings |
| empty | 成功但 `isEmpty` 谓词为真 | EmptyState（可带 CTA） | CTA 回调 |
| ready | 成功且有数据 | children(data) | 业务事件 |

### 2.2 AppShell（布局容器）

| 状态 | 事件 → 转换 |
|---|---|
| sidebarWidth / rightPanelWidth（[200,400] / [260,360]） | resizer mousedown → 全局 mousemove 实时更新 + body.resizing → mouseup 解除 |
| sidebarCollapsed / rightPanelCollapsed | 顶栏按钮 / 右面板竖条按钮 → 取反 + manualRef 置位；断点变化 → 自动折叠（仅未手动时） |
| draggingSide（left/right/null） | 拖拽中 → 对应 resizer 加 .dragging |
| isWelcomeMode（welcome-store） | enterWelcomeMode()/exitWelcomeMode() → .view-chat class 切换 |

挂载的全局订阅（L4，AppShell 生命周期内）：useApprovalBridge / useAgentAskBridge / useToolBridge / useAgentBridge / useTerminalBridge / useProtocolCheck；全局快捷键绑定（useKeyboardShortcuts）。

### 2.3 Topbar

| 按钮 | 状态 | 事件 |
|---|---|---|
| 折叠侧栏 | aria-expanded | click → onToggleSidebar |
| 返回（聊天页才渲染） | — | click / Alt+← → navigate('/') |
| 命令面板胶囊 | — | click / Ctrl+P → openPalette |
| 右面板开关 | aria-expanded | click → onToggleRightPanel |
| 设置 | ghost | click → openSettings |
| 主题 | resolvedTheme | click → **两态**切换 light↔dark（注意：快捷键 Ctrl+Shift+T 是三态循环，现状不一致，如实标注） |

### 2.4 Sidebar 系（Sidebar / FolderLabel / SortableThreadItem）

| 组件 | 状态 | 事件 → 转换 |
|---|---|---|
| Sidebar | activeTab: recent/archived；searchKeyword（仅 UI）；sidebarView: threads/fileTree | tab 点击；搜索输入（无过滤逻辑，占位）；切换视图 |
| Sidebar 列表 | view 五态（useAsyncView） | 删除 mutation isPending 时项禁用 |
| FolderLabel | collapsed（persistent） | 点击折叠箭头 → toggleFolder；hover 显示 + → handleCreateInFolder |
| ThreadItem | active / renaming / isDeleting / isPinned | click 选中（Enter/Space 同效）；双击 → renaming；内联输入 Enter 提交 / Esc 取消 / blur 提交；hover 文件树按钮 → 开文件树；⋯ 菜单：置顶(取反)/重命名/删除 |
| 拖拽排序 | isDragging（dnd-kit） | ti-dot 拖拽（4px 激活）→ dragEnd 同文件夹 arrayMove → 写 orderOverrides |

### 2.5 文件树（FileTreePanel / FileTreeNode / 内联输入）

| 状态 | 事件 → 转换 |
|---|---|
| rootPath null / 加载中 | useFileTree 挂载 → file:list + file:watch:start → store 填充 |
| 目录 expandedPaths | 点击箭头 → setExpanded + file:list 拉子目录 |
| pendingOps（Set<path>） | 新建/删除/重命名进行中 → 对应节点禁用，防重复操作 |
| creatingEntry / renamingPath | 菜单/工具栏 → 行内 input（tempName）；Enter 提交 → IPC → watch 事件同步刷新；Esc → 取消 |
| 选中文件 | 点击 → openFile(path) → file-viewer-store |

### 2.6 ChatPanel（聊天容器）

| 状态 | 事件 → 转换 |
|---|---|
| useAgentWithIpc.status：ready/submitted/streaming/error | sendMessage → submitted（THINKING）→ streaming（RUNNING）→ end → ready；onError → error → toast（错误码 i18n，双保险不抛错） |
| interruptedDismissed | 中断条关闭 → 不再显示 |
| search（useConversationSearch） | open/search/navigate/close → 状态条 + 搜索栏 + 消息高亮联动 |
| usage（usage-store per-session） | 回合 end 携带 usage → 累加 → 状态条 token 展示 |
| editorFontSize（settings） | 设置变更 → 整个面板字号（消息区真实消费） |

### 2.7 ChatInput（输入舱，交互最密集）

| 状态 | 事件 → 转换 |
|---|---|
| isStreaming（status ∈ {streaming, submitted}） | 按钮 发送→停止；Esc（textarea 内 + window 级兜底）→ onStop；流式期间**不禁用**输入（可预输入） |
| canSend = 非空 && !isStreaming && !disabled | 输入/停止变化时重算；点击发送 → handleSend |
| value / attachments（受控或内部+草稿） | onChange → autoResize（1-8 行，240px 封顶）；草稿写 draft-store（chatId 存在时）；chatId 变化 → 恢复新会话草稿 |
| charCount >2000 | 计数变警告色（aria-live） |
| 超长拦截 | >8000 字符 → toast.error，不发送 |
| slashOpen（/ 开头且无空格） | 输入过滤 → 建议下拉；Tab/Enter 应用（带 action 的直接执行并清空输入）；Esc 关闭（清空斜杠输入） |
| composerDragH（[40,460]） | 手柄 pointerdown 拖拽（向上拉高，下限=内容自然高度）；双击重置；键盘 ↑↓ 20px 步进 |
| 附件 chips | @ 按钮 → dialog.pickFiles 多选去重 → chip（可移除）→ 发送时 file:read 拼接（≤4000 字符，失败仅标注文件名） |
| 发送成功 | 清空输入 + 清附件 + clearDraft |

### 2.8 ChatMessageList

| 状态 | 事件 → 转换 |
|---|---|
| showScrollBtn / hasNew | scroll（距底 >80px → 显示；新消息到达且不在底部 → hasNew 红点）→ 点击 → 平滑滚底 |
| searchActiveIndex | 搜索导航 → scrollIntoView 居中 + .search-highlight |
| messages 空 | EmptyState（开始新对话） |
| 流式 | messages.length/isStreaming 变化 → 底部跟随或 hasNew |

### 2.9 消息项（MessageItem / PartView / ToolCallView / ReasoningBlock）

| 组件 | 状态 | 事件 |
|---|---|---|
| MessageItem | user/assistant/system 角色 | user 仅文本气泡；assistant 头像+角色行+parts+操作栏；system 居中 |
| MsgActions | hover 显示 | 复制（clipboard）；重新生成（流式中禁用）→ regenerate({messageId}) 截断重发 |
| ToolCallView | open 折叠态；state：pending/running/success/error | 点击 card-head 展开/收起；标题来自 tool-store（AgentToolResultPayload 人类可读标题，缺失回退工具名） |
| ReasoningBlock | open（默认随 experimental.reasoningCollapsed；用户显式覆盖后以 override 为准，持久于 reasoning-collapse-store） | 点击头 → setCollapsed(messageId) |
| FileChangeCard | 折叠态 | 点击展开 diff 行（created=write_file / modified=edit_file） |

### 2.10 审批系（InlineApprovalCard / useApprovalBridge / approvals-store）

| 状态 | 事件 → 转换 |
|---|---|
| pending → approved / rejected | 主进程 agent:approval:request → bridge → store.pending 入队；点「批准」→ store.approve + agent:approval:response({approved:true, rememberDecision})；「拒绝」→ reject + response(false)；「白名单」→ approve + rememberDecision:true（主进程写 whitelist-pref） |
| 已决回显 | resolved 队列保留 1s 后出队（便于 UI 反馈）；当前会话最近一条仍回显 |
| 审批模式（ask/auto-approve/deny） | 设置页单选 → settings:setApprovalMode（失败回滚 + toast）→ PermissionService 同步 |

### 2.11 AskDialog

| 状态 | 事件 |
|---|---|
| open（agent-ask-store） | 主进程 agent:event:ask → bridge → setAsk → Dialog 打开 |
| 提交 | 选项 + 文本 → agent:ask:respond → 关闭；取消 → respond 空回答 |

### 2.12 ConversationSearchBar

| 状态 | 事件 |
|---|---|
| visible/query/totalMatches/currentMatch | 输入 → search()；↑↓/Enter/Shift+Enter → navigate() 循环；关闭 → close() |

### 2.13 RateLimitBanner

| 状态 | 事件 |
|---|---|
| visible（触发 5 分钟内有效） | agent/chat 回合 error 且为 429 → rate-limit-store → 横幅显示；手动 × 关闭 / 超时自动消失 |

### 2.14 ModelSelector

| 状态 | 事件 |
|---|---|
| query（models:list，L3） | 提供商下拉（仅"已配置 API Key"的提供商，实事求是）→ onProviderChange；模型下拉（默认模型）→ onModelChange |

### 2.15 CommandPalette

| 状态 | 事件 |
|---|---|
| open（受控）+ query | cmdk 键盘导航（↑↓/Enter/Esc）；fuse 模糊搜索（threshold 0.4）；分组渲染；条目 select → action + 关闭 |

### 2.16 设置页与 sections

| 组件 | 状态 | 事件 |
|---|---|---|
| SettingsDialog | activeSection（打开时重置 models） | 导航点击 / ↑↓ 循环 |
| ProviderRow（models） | expanded / showPlain / isConfigured / isSaving / isDeleting | 行点击展开；输入 API Key → 保存/删除（settings:setApiKey/deleteApiKey，toast 反馈） |
| 运行时模型表单 | adding/removingId | 添加/删除 → settings:addRuntimeModel/removeRuntimeModel → models:list 刷新 |
| ShortcutPicker | 录制中 | 点击 → 捕获按键 → settings-store.shortcuts 持久化（v3 迁移：Windows 默认 Ctrl 前缀） |
| 语言行 | lang | 点击 → changeLanguage（立即生效，localStorage code-agent:lang） |
| 审批模式/白名单 | mode / whitelist 列表 | useApprovalMode（失败回滚）；白名单增删 → whitelist:add/remove |
| 遥测 | level | setTelemetryLevel → 提示"重启生效" |
| 系统提示词 | editing/draft | 编辑 → 保存 → settings-store.ai.systemPrompt（透传 agent:run） |
| 数据管理 | 导出中 | session:exportAll（主进程弹保存对话框）→ toast；打开数据目录 app:openDataDir |
| MCP/技能/规则记忆 | 各自 query/mutation 态 | mcp:list/start/stop；skill:list/listLearned/learn/removeLearned；memory:list/clear |

### 2.17 FileViewerDialog

| 状态 | 事件 → 转换 |
|---|---|
| open/filePath（store） | 文件树点击 → openFile |
| loading/error（file:read query） | — |
| editMode / isDirty / originalContent / editedContent | 「编辑」→ 进入编辑；输入 → isDirty；Ctrl+S → file:write（成功 invalidate read 缓存 + markSaved；失败保留编辑态）→ 保存中禁用 |
| 关闭保护 | isDirty 时关闭 → 确认弹层；确认丢弃 / 取消 |

### 2.18 右面板各 tab

| 组件 | 状态 | 事件 |
|---|---|---|
| DevPanel | activeTab / devSubTab | tab 点击切换（懒加载 Suspense "加载中…"） |
| GitPanel | status query + selectedFilePath + diff query（选中才启用） | 刷新按钮 refetch；文件行点击 → 查询 diff → FileDiffView 双栏 |
| TerminalPanel | 无实例（"创建终端"）/ 运行中 / 已退出 | 创建 → terminal:create；输入 onData → terminal:input；关闭 → terminal:kill；resize（ResizeObserver 100ms 防抖）→ terminal:resize；exit 事件 → store.markExited |
| LogsPanel | 级别过滤（all/info/warn/error/debug）+ 行数（100/200/500） | 手动刷新 → refetch |
| MetricsPanel | query（5s stale / 10s refetchInterval，enabled=面板可见） | 自动刷新 |
| InspectorPanel | 停靠模式（detach/right/bottom） | 点击 → devtools:open → toast 反馈（3s 自动清除） |
| BrowserPane | 地址/设备预设（responsive/desktop/tablet/mobile） | iframe 导航/后退/前进/刷新 |

### 2.19 错误边界三层

| 层 | 状态 | 事件 |
|---|---|---|
| AppErrorBoundary | 崩溃 | 「重新加载」→ window.location.reload()；「发送报告」→ Sentry.captureMessage 显式补报 |
| RootErrorBoundary | 路由错误 | 「重新加载」按钮 |
| SectionErrorBoundary | 区块错误（sidebar/main/right-panel/设置 pane） | 内联错误提示 + 重试 |

### 2.20 UpdateNotice

| 状态 | 事件 |
|---|---|
| available/downloaded/not-updated/error | update:event:status 推送 → toast（同阶段防抖不重复弹）；downloaded → 「重启安装」→ update:install |

---

## 三、交互流程与逻辑

### 3.1 会话创建流程（欢迎页 → 聊天页）

```
点击「新建会话」/ 文件夹 + 按钮 / Ctrl+N / 命令面板「新建会话」
→ clearActiveSession + enterWelcomeMode(复用最近 workingDir) + navigate('/')
→ HomePage：可选项目（历史目录/浏览其他目录），快捷 pill 预填输入
→ 回车发送：workingDir 为空？→ toast「选择项目」+ 展开 dropdown（不弹原生框）
→ createSession({workingDir}) → setActiveSession + exitWelcomeMode + navigate(/chat/:id)
→ 首条消息经 sessionStorage 暂存 → ChatPanel 挂载后自动发送
```
边界：创建中 isPending 禁用发送与 pill（防重复提交）；createSession 失败 → toast + 保持欢迎页可重试；URL 直访 /chat/:id 且会话不存在 → 重定向首页。

### 3.2 消息发送 → 流式 → 停止 → 重新生成

```
ChatInput Enter（或发送按钮）
→ canSend 校验（非空/非流式/非禁用）→ 8000 字符拦截 → 附件读取拼接
→ sendMessage({text}) → useChat 调 transport.sendMessages
→ convertToModelMessages → window.api.agent.run({sessionId: chatId, workingDir, maxSteps:20, mode:'build', thinking})
→ 主进程 AgentService.startAgent（并发门 FIFO 排队）→ streamText 多轮工具循环
→ 推送 agent:stream:part（text/tool-call/tool-result/finish）→ transport 按 sessionId 过滤 enqueue → useChat 更新 messages
→ agent:stream:end → controller.close → status=ready；useAgentBridge invalidate 会话缓存 + 清理 tool/approvals 缓冲 + usage 累积
→ agent:stream:error → controller.error(`[CODE] msg`) → onError → toast（i18n 错误码，双保险）
停止：按钮/Esc/卸载 → agent:stop → 主进程 abort → 推送 reason='aborted' 的 END
重新生成：MsgActions → regenerate({messageId}) → 截断该消息及后续 → 重新 run
```
边界：config 未配置（无 workingDir）→ transport reject；浏览器模式无 window.api → 守卫返回空。

### 3.3 工具调用与审批流程

```
Agent 回合中 → ToolExecutor 执行工具
→ permission='ask'（危险/白名单未命中）→ 推送 agent:approval:request
→ useApprovalBridge 入队 approvals-store → InlineApprovalCard 就地展示（不弹窗打断）
→ 用户点「批准/拒绝/白名单」→ store 更新 + agent:approval:response → PermissionService resolve pending Promise
→ 工具继续/中止 → agent:tool:result（或 TOOL_ABORTED）推送 → tool-store 配对更新
审批模式=auto-approve 时主进程直接放行；=deny 时直接拒绝（UI 无感知，仍推送 result）
```
边界：单个会话多个 pending 审批（批量编辑）FIFO；已决项 1s 出队；危险工具（delete_file/run_command/install_package）批准按钮红色；白名单写入 whitelist-pref.json（approval-mode-section 可管理）。

### 3.4 会话管理（切换/重命名/置顶/删除/拖拽）

```
切换：点击项 → setActiveSession + navigate(/chat/:id) → useSessionDetail 拉详情
重命名：双击标题或菜单 → 内联 input → Enter/blur 提交 → session:rename（乐观更新+失败回滚+invalidate）
置顶：菜单 → session:pin({pinned}) → invalidate（服务端排序在前）
删除：菜单 → session:delete（乐观删除+失败回滚+onSettled invalidate）→ 若为激活会话 → clearActiveSession + navigate('/')
拖拽：ti-dot 拖拽 → 同文件夹重排 → orderOverrides（localStorage，跨重启保留）
```
边界：删除激活会话自动回首页；isDeleting 期间禁用操作按钮；空列表 → EmptyState（无 CTA，头部已有新建按钮）。

### 3.5 文件树操作流程

```
新建：工具栏/菜单 → 行内 input → Enter → file:create / file:createDir → pendingOps 置位禁用
→ watch 事件（create）增量更新 store → 目录自动展开
重命名：菜单 → 行内 input → file:rename → watch(rename) 更新
删除：菜单 → file:delete → watch(delete) 移除；目录删除级联
刷新：头部按钮 → file:list 重拉根目录（watch 失效兜底）
实时同步：useFileTree 订阅 file:watch:event → store upsert/remove/rename；watch 失败 → toast「文件监听已失效」+ 提示刷新
```
边界：pendingOps 防重复操作；错误 toast（createFileFailed 等）；内联输入 Esc 取消不落盘。

### 3.6 文件查看器编辑保存流程

```
点击文件 → openFile → useFileContent(file:read，缓存 30s/5min)
「编辑」→ editMode + 编辑内容缓存于 store → 输入 → isDirty
Ctrl+S → file:write → 成功 invalidate ['file',path] + markSaved；失败 toast + 保留编辑内容
关闭：isDirty → 确认弹层（丢弃/取消）；保存后正常关闭
```
边界：二进制/超大文件读取失败 → error 态；路径变化自动重新查询（enabled=open）。

### 3.7 终端生命周期

```
TerminalPanel 挂载（无实例）→「创建终端」→ terminal:create → store 记录元数据 → xterm 初始化
→ 订阅 terminal:event:output 直写 xterm（不经 store 中转，防抖仅 resize）
→ 输入 onData → terminal:input → 主进程 PTY → 输出回流
→ 关闭 → terminal:kill + store.closeTerminal；exit 事件 → markExited（输出保留）
→ 会话切换 → 按 sessionId 查找/创建对应终端实例
```

### 3.8 Git 查看流程

```
GitPanel 挂载 → useGitStatusQuery(git:status，stale 10s)
→ 文件列表点击 → useGitDiffQuery（enabled=选中，每次新请求不缓存）
→ parseUnifiedDiff → UnifiedDiffView 双栏渲染
→ 刷新按钮 → refetch
```
边界：非 git 仓库 → ErrorHint；工作区干净 → CleanHint；只读无写操作（不提供 commit/push）。

### 3.9 命令面板流程

```
Ctrl+P / 顶栏胶囊 / Shift+/ → ui-store.openPalette → cmdk 渲染
→ 输入 → fuse 模糊过滤 → ↑↓ 选择 → Enter 执行（新建会话/切主题/开设置/切文件树视图/开文件/切会话）
→ 执行动作 + closePalette
```
边界：无匹配 → CommandEmpty；文件命令 ≤50、会话命令 ≤20（防列表过长）；Esc/遮罩点击关闭。

### 3.10 会话内搜索流程

```
状态条 🔍 → search.actions.open → 搜索栏显示 → 输入 → 匹配（消息级纯函数）
→ ↑↓/Enter 循环导航 → 目标消息 scrollIntoView 居中 + .search-highlight
→ 关闭 → 高亮清除
```

### 3.11 设置修改流程（各写入型设置）

| 设置 | 链路 | 失败处理 |
|---|---|---|
| API Key | 输入 → settings:setApiKey → keychain（DPAPI 加密）→ invalidate ['api-key',provider] | toast + 保留输入 |
| 运行时模型 | 表单 → settings:addRuntimeModel/removeRuntimeModel → SQLite runtime_models → 重新拉取 | toast |
| 审批模式 | useApprovalMode → settings:getApprovalMode/setApprovalMode → approval-pref.json → PermissionService | 失败回滚原值 |
| 白名单 | whitelist:list/add/remove → whitelist-pref.json | toast |
| 遥测 | settings:getTelemetryLevel/setTelemetryLevel → telemetry-pref.json | toast + 提示重启生效 |
| 语言 | changeLanguage → localStorage code-agent:lang | — |
| 快捷键 | ShortcutPicker → settings-store.shortcuts（localStorage，v3 版本迁移） | — |
| 系统提示词 | 编辑保存 → settings-store.ai.systemPrompt → 下次 agent:run 透传 | — |
| 主题 | setTheme → settings-store.theme → ThemeProvider 应用 .dark class | — |
| MCP | mcp:start/stop → MCPService 子进程 → 工具注册/注销 → invalidate mcp:list | 错误显示于 server 行 |

### 3.12 边界情况总表

| 场景 | 处理 |
|---|---|
| 空态 | 会话空/文件树空/搜索无结果/归档空 → EmptyState（侧栏空态无 CTA） |
| 错误态 | 全部 L3 查询 → AsyncBoundary error（`[CODE]` i18n + 重试 + 恢复动作） |
| 加载态 | 首载 >200ms 骨架屏防闪烁；刷新保留旧数据不闪 |
| 防重复提交 | 创建会话 isPending 禁用；发送流式中按钮变停止；文件操作 pendingOps |
| 输入长度限制 | 消息 8000 拦截；附件 4000 截断；工具 JSON 200 字符；重命名空值忽略 |
| 脏数据保护 | 查看器 isDirty 关闭确认 |
| Esc 中断 | 流式中断（window 级）；斜杠建议关闭；dropdown/浮层关闭 |
| window.api 未定义 | 全部 IPC 调用点守卫（浏览器模式：空列表/空骨架/静默跳过，预览不崩溃） |
| 版本错配 | useProtocolCheck → toast 提示重启 |
| 崩溃恢复 | 主进程 crash-marker → 残留会话标记 interrupted → 聊天页顶部提示条 |
| 限流 | 429 → rate-limit-store → 横幅（5 分钟有效） |
| 超长列表 | 命令面板文件 ≤50 / 会话 ≤20；侧栏 50 条分页（session:list limit=50） |

---

## 四、数据链路

### 4.1 链路总览

```
组件 useState/L1 ──→ L2 Zustand（persistent/transient）
        ↓                          ↑
   L3 TanStack Query ──→ window.api.*（preload，createIpcApi 遍历 IPC_META 生成）
                                  ↓
                contextBridge → ipcRenderer.invoke(channel, payload)
                                  ↓
        src/main/ipc/*.handler（wrap：traceId + sender 校验 + zod 入参/响应校验 + 错误分类 + Sentry）
                                  ↓
        ServiceContainer 持有 25 个域服务（Agent/Chat/File/Search/Terminal/Git/Codebase/Session/...）
                                  ↓
        SQLite（sessions/messages/token_usage/turns/runtime_models/goals/memories/tasks/skills）
        keychain（DPAPI）｜ JSON 偏好文件（telemetry/approval/whitelist）｜ 外部进程（PTY/git/codegraph/ripgrep/MCP）｜ LLM Provider

反向推送：Service → webContents.send(channel) → preload 订阅 → renderer window.api.*.subscribe* → 桥接 hook → L2 store → UI
```

### 4.2 会话域 session:*

| 通道 | 前端入口 | 数据去向 |
|---|---|---|
| `session:list` | useSessionsQuery（L3，`['sessions']`，stale 30s，limit 50）→ Sidebar | SessionService → SQLite `sessions` 表 |
| `session:get` | useSessionDetail（`['session',id]`，enabled=id≠null）→ ChatPage | SQLite `sessions` + `messages`（完整历史） |
| `session:create` | useCreateSession（mutation）→ HomePage | 新建会话绑定 workingDir |
| `session:delete` | useDeleteSession（乐观删除 + onSettled invalidate） | 级联删消息 |
| `session:rename` | useRenameSession（乐观更新） | 更新标题 |
| `session:pin` | usePinSession（onSettled invalidate） | 置顶排序 |
| `session:listRecentDirs` | useRecentDirs（`['session','recent-dirs']`）→ HomePage dropdown | 去重 + lastUsed 倒序 |
| `session:exportAll` | DataSection → 主进程弹保存框 + 写 JSON 文件 | 数据迁移 |
| `session:getUsageSummary` | UsageSection（`['usage','summary']`） | token_usage 聚合（今日/近30天/累计/模型占比/热力图） |
| `session:getRecentTurns` | TurnsSection | `turns` 表（终止原因 + token） |

### 4.3 Agent 域 agent:*

| 通道 | 方向 | 链路 |
|---|---|---|
| `agent:run` | req | ChatInput → useAgentWithIpc → IpcAgentTransport（configure 注入 workingDir/systemPrompt/maxSteps/mode/thinking）→ AgentService.startAgent → 并发门 FIFO → llmClient（Provider）→ streamText + 工具循环 |
| `agent:stop` | req | 停止按钮/Esc/流 cancel → AbortController → reason='aborted' |
| `agent:stream:part` | push | 主进程按 part 推送 → transport 按 sessionId 过滤 → ReadableStream → useChat messages |
| `agent:stream:end` | push | → transport close → useAgentBridge：invalidate `['sessions']` + `['session',id]`、tool-store/approvals-store clearBySession、usage-store addUsage（回合结束统一清理） |
| `agent:stream:error` | push | → transport error(`[CODE]`) → ChatPanel onError → toast |
| `agent:tool:call` / `agent:tool:result` | push | ToolExecutor 推送（入参/权限级别；输出/错误）→ useToolBridge → tool-store（toolCallId 配对）→ 消息工具卡 + 右面板 DiffPane/FilesPane |
| `agent:approval:request` | push | PermissionService → useApprovalBridge → approvals-store |
| `agent:approval:response` | req | 审批按钮 → PermissionService resolve |
| `agent:event:ask` / `agent:ask:respond` | push/req | Agent 提问 → agent-ask-store → AskDialog → 回答回传 |
| `agent:turn:event` | push | 回合状态机事件（订阅预留，见 useAgentBridge 侧链路） |

### 4.4 文件域 file:*

| 通道 | 链路 |
|---|---|
| `file:list` / `file:read` | useFileTree（直接 IPC，结果入 file-tree-store——与 watch 合并，不走 Query 缓存）/ useFileContent（L3，`['file',path]` stale 30s gcTime 5min） |
| `file:watch:start/stop` + `file:watch:event`(push) | useFileTree：workingDir 变化 → watchStart → 订阅事件 → store upsert/remove/rename（增量更新，watch 失败 toast） |
| `file:write` | useFileWrite（mutation）→ 成功 invalidate `['file',path]` |
| `file:create/createDir/delete/rename` | useFileTreeOps（pendingOps 防重；结果靠 watch 事件同步） |

### 4.5 终端域 terminal:*

`terminal:create`（TerminalPanel 无实例时）→ TerminalService（node-pty 子进程）→ `terminal:event:created/output`(push) 直写 xterm → `terminal:input` / `terminal:resize`（100ms 防抖）/ `terminal:kill` → `terminal:event:exit`(push) → store.markExited。

### 4.6 Git 域 git:*

`git:status`（L3，`['git','status',path]` stale 10s）→ GitService（spawn git CLI）；`git:diff`（选中文件才启用，每次新请求不缓存）。`git:add/commit/push` 定义表中存在但**渲染层无调用方**（面板只读，不适用标注）。

### 4.7 设置域 settings:* 与偏好持久化

| 通道 | 存储 |
|---|---|
| `settings:getApiKey/setApiKey/deleteApiKey` | keychain（safeStorage DPAPI；查询 stale Infinity，显式变更才失效） |
| `settings:getTelemetryLevel/setTelemetryLevel` | telemetry-pref.json（重启生效） |
| `settings:getApprovalMode/setApprovalMode` | approval-pref.json（启动时 PermissionService 同步） |
| `settings:addRuntimeModel/removeRuntimeModel/listRuntimeModels` | SQLite `runtime_models`（启动时 runtimeModelStore.loadAll 注册到 ModelRegistry） |
| `whitelist:list/add/remove` | whitelist-pref.json |
| 主题/快捷键/编辑器/实验开关/草稿/侧栏偏好 | 渲染层 localStorage（createPersistentStore，`code-agent:` 前缀 + 版本迁移，失败静默降级内存） |

### 4.8 其他域一览

| 域 | 通道 | 消费方 | 数据去向 |
|---|---|---|---|
| models | `models:list` | ModelSelector（`['models','list']`） | ModelRegistry + runtime_models（仅已配置 Key 的提供商） |
| mcp | `mcp:list/start/stop` | McpSection | MCPService（子进程 + ToolRegistry 注册/注销） |
| skill | `skill:list/listLearned/learn/removeLearned` | SkillsSection | SQLite `skills` + learn-skill-agent |
| memory | `memory:list/clear` | RulesMemorySection（按会话） | SQLite `memories` |
| goal / task | `goal:list/clear/create`、`task:list` | InfoPane（L3，按 sessionId） | SQLite `goals` / `tasks` |
| app | `app:getStatus/getInfo/openExternal/openDataDir` | useProtocolCheck / AboutSection / DataSection | 主进程 + 数据目录 |
| system | `system:getStatus` | MetricsPanel（stale 5s，refetchInterval 10s，enabled 面板可见） | 主进程运行时指标 |
| logs | `logs:read` | LogsPanel（stale 0，手动刷新） | electron-log main.log |
| devtools | `devtools:open` | InspectorPanel | webContents.openDevTools（detach/right/bottom） |
| dialog | `dialog:pickDirectory/pickFiles` | HomePage / ChatInput | Electron 原生对话框 |
| update | `update:check/install` + `update:event:status`(push) | UpdateNotice / useUpdate | electron-updater（打包环境才可用） |
| im | `im:list/start/stop` | ImChannelsSection | ImService + 渠道适配器（企微/钉钉/飞书等） |
| search | `search:grep/glob` | 渲染层无直接调用方（工具内部使用） | SearchService（ripgrep） |
| codebase | `codebase:*` | 渲染层无直接调用方（工具内部使用） | CodebaseService（codegraph） |
| tool | `tool:list` | approval-mode-section 工具下拉 | ToolRegistry |
| audio | `audio:start/append/stop` | 渲染层无 UI 调用方 | AudioService（无 UI，标注不适用） |

### 4.9 缓存/失效/重试策略汇总

| 策略 | 值 | 出处 |
|---|---|---|
| QueryClient 全局 | staleTime 30s / gcTime 5min / refetchOnWindowFocus off / retry 1 / mutation retry 0 | query-client.ts |
| 覆盖：git status | stale 10s（变化快） | use-git |
| 覆盖：system status | stale 5s + refetchInterval 10s + enabled 控制 | use-system |
| 覆盖：logs | stale 0（每次最新） | use-system |
| 覆盖：api-key | stale Infinity（显式变更才失效） | use-api-key |
| 覆盖：file 内容 | stale 30s / gcTime 5min（关窗再开秒开） | use-file-content |
| mutation 失效 | delete/rename/pin → invalidate `['sessions']`；create → +`['recent-dirs']`；write → `['file',path]`；apiKey → `['api-key',provider]`；mcp start/stop → mcp:list | 各 hook |
| 乐观更新 | delete（本地移除）、rename（本地改标题），失败回滚 + onSettled 重新拉取 | use-sessions |
| 回合结束 | invalidate sessions + 详情；tool/approvals clearBySession；usage 累积 | use-agent-bridge |
| 崩溃恢复 | 启动 markAllInterrupted → 渲染层中断提示条 | service-container |

### 4.10 写操作失败兜底

所有 IPC 写操作失败路径：`unwrap`/discriminated union 判断 → `[CODE] message` → toast（i18n errors.json 错误码文案，解析失败回退原始消息）→ 状态回滚（乐观更新回滚 / 审批模式回滚 / pendingOps 清除）。

---

## 五、完整性与可信度（逐文件核对）

### 5.1 文件清单（UI 职责 + 数据来源 + 实现状态）

**入口与路由（6）**

| 文件 | 职责 | 数据来源 | 状态 |
|---|---|---|---|
| main.tsx | 挂载根 + StrictMode | — | 已实现 |
| App.tsx | Provider 组装 + 错误边界 | — | 已实现 |
| router.tsx | RR8 Data Mode 路由（lazy 首页/聊天页） | — | 已实现 |
| routes/root.tsx | 根布局 + HydrateFallback + 路由错误边界 | — | 已实现 |
| routes/home.tsx | 欢迎页 | session:listRecentDirs / dialog:pickDirectory | 已实现 |
| routes/chat.tsx | 聊天页（路由守卫） | session:get | 已实现 |

**布局（6）**：AppShell（栅格/折叠/拖拽/断点 + 全局桥接挂载）、Topbar、Sidebar（分组/拖拽/置顶）、folder-label、thread-item（内联重命名 + 菜单）、DevPanel（6 tab）。全部已实现。

**chat 域（11）**：ChatPanel、ChatInput、ChatMessageList、message-item、message-actions、message-utils、streaming-footer、Markdown（shiki 双主题）、file-change-card、conversation-search-bar、rate-limit-banner。全部已实现。

**agent 域（4）**：inline-approval-card（已实现）、ask-dialog（已实现）、approval-preview（已实现）、approval-utils（已实现）。

**common（9）**：AppErrorBoundary、SectionErrorBoundary（已实现）；AsyncBoundary + useAsyncView（五态，已实现）；CommandPalette（已实现）；EmptyState（已实现）；ModelSelector（已实现，数据源 models:list）；ShortcutHelpDialog（已实现，注意 Ctrl+B/Ctrl+J 帮助表项与实际绑定不一致）；UnifiedDiffView（已实现）；UpdateNotice（已实现）。

**file-tree（8）**：FileTreePanel/FileTreeNode/FileTreeNavigator/inline-create-input/inline-rename-input/node-menu/FileViewerDialog/file-viewer-utils。全部已实现。

**git（5）**：GitPanel/file-list/file-diff-view/git-panel-parts/git-status-utils。只读已实现；`git:add/commit/push` 通道定义存在但渲染层无 UI（不适用）。

**dev（4）**：browser-pane（已实现）、InspectorPanel（已实现）、LogsPanel（已实现）、MetricsPanel（已实现）。

**terminal（2）**：TerminalPanel（已实现）、loading-ui/terminal（加载动画）。

**settings（23）**：SettingsDialog + shortcut-picker + settings-controls（已实现）+ sections 20 个——about/approval-mode/browser/data/editor/experimental/general/im-channels/mcp/model-params/models/prompt/rules-memory/shortcuts/skills/telemetry/turns/usage/workspace（已实现；browser 为说明页）；placeholders（account/mobile/plugins/hooks/commands 为占位）。

**hooks（22）**：use-agent（transport 注入）、use-sessions（7 个 query/mutation）、use-git、use-file-tree、use-file-tree-ops、use-file-content、use-file-write、use-api-key、use-telemetry、use-update、use-system、use-protocol-check、use-layout-breakpoint、use-async-view、use-keyboard-shortcuts、use-conversation-search、use-agent-bridge、use-agent-ask-bridge、use-approval-bridge、use-approval-mode、use-tool-bridge、use-terminal-bridge。全部已实现。

**stores（16）**：persistent/（create-persistent-store 工厂、settings、sessions、sidebar-pref、draft）+ transient/（ui、welcome、file-tree、file-viewer、tool、approvals、agent-ask、rate-limit、reasoning-collapse、terminal、usage）。全部已实现。

**providers（3）**：I18nProvider、ThemeProvider、QueryProvider（+ TooltipProvider/Toaster 由 ui 组件提供）。已实现。

**lib（10+）**：ipc（unwrap）、error-actions（错误码恢复）、constants（ROUTES/尺寸/草稿 id）、format-time、utils（cn）、theme-init、agent/ipc-agent-transport（核心流式桥接）、query/query-client、motion/*、diff/*。已实现。

**i18n**：config（zh-CN/en，`code-agent:lang` 持久化）、use-translation、locales/*。已实现。

### 5.2 实现状态汇总

- **已实现**：以上全部交互/数据链路（会话 CRUD、流式 Agent、审批+白名单、文件树+watch、查看器编辑、终端 PTY、Git 只读、用量统计、MCP/技能/记忆管理、IM 渠道配置、i18n、主题、快捷键、更新提示、崩溃恢复）。
- **部分实现**：侧栏搜索框（仅 UI 无过滤）；归档 tab（恒空）；斜杠命令 /models /compact /help（toast 引导）；vim 模式（存储无行为）；设置快捷键帮助表中 Ctrl+B/Ctrl+J（未绑定）。
- **占位**：设置页 账号/移动端/插件/hooks/命令 分区（"🚧 规划中"）。
- **不适用（NONE，诚实不提供）**：退出登录/云端账户（无登录后端）；Git commit/push UI（只读防误操作）；codebase/search/audio 域无渲染层 UI；独立审批对话框（已移除，改内联卡）。

---

## 六、交付摘要（占位 / 不适用清单）

1. **占位（规划中，UI 已存在但无后端能力）**：侧栏搜索过滤、归档 tab、设置页账号/插件/hooks/命令/移动端分区、斜杠命令部分动作（toast 引导）、vim 模式、浏览器设置配置项。
2. **不适用（NONE，诚实不渲染）**：退出登录、Git 写操作 UI、codebase/search/audio 域 UI、独立审批对话框（已内联化）。
3. **已知不一致（如实记录）**：顶栏主题两态 vs 快捷键三态循环；快捷键帮助表 Ctrl+B/Ctrl+J 未实际绑定；DEFAULT_GIT_REPO_PATH 为硬编码 `f:\TraeProjects\1`（配置化后续增强）。
