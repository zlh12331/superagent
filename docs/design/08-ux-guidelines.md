# UX 设计规范

> 基于 `code-agent-desktop` 前端实际代码整理（`src/renderer/` 为唯一真源）
> 整理时间：2026-08-09
> 覆盖范围：信息架构 / 视觉规范 / 核心交互流程 / 反馈与异常状态 / 键盘与可访问性 / 国际化 / 实事求是清单 / 验收清单

## 1. 文档定位与设计原则

本文档描述跨平台桌面端（Windows/macOS/Linux）Code Agent（AI 代码助手）的前端用户体验规范，用于指导 UI 开发、评审与验收。所有条目均可追溯到具体代码文件，**不包含虚构或规划中的能力**。

### 1.1 三条核心原则

| 原则 | 含义 | 代码体现 |
|---|---|---|
| **实事求是** | 后端无数据源的能力不渲染假 UI；规划中功能诚实标注 | 侧栏搜索框仅 UI 不过滤；归档 tab 计数恒 0；设置页 account/plugins/hooks 等为"规划中"占位；侧栏底部账户无"退出登录" |
| **原型对齐** | 原型阶段已结束：`docs/prototype/prototype-v2.html` 与 `codex-desktop-prototype.design/` 已于 2026-08-30 删除，交互真源改为已实现代码与 09-ux-interaction-spec | 三段式 grid、welcome-mode、composer-project-bar、composer-stats-bar、消息导航轨、滚动到底部按钮等 |
| **可访问性（WCAG AA）** | 文字对比度 ≥4.5:1；全部颜色经设计令牌输出 | `globals.css` 注释标注关键对比度实测值；浅色导航激活态用 `text-foreground` 而非青色 `text-primary`（2.51:1 不达标） |

### 1.2 状态管理四层架构（UX 侧约定）

```
L1 useState         组件内瞬态（输入框/折叠态/编辑态）——不跨组件
L2 Zustand          客户端共享状态：
                    persistent/ 跨重启（settings / sessions / sidebar-pref / draft）
                    transient/  会话内（ui / file-tree / tool / approvals / rate-limit /
                                reasoning-collapse / terminal / usage / welcome / file-viewer / agent-ask）
L3 TanStack Query   IPC 请求-响应数据（会话列表 / git diff / usage summary），带缓存/失效/重试
L4 IPC 事件流       主进程推送（agent:tool:call / terminal:event:output / update:status）
                    → subscribe 直接写 transient store
```

判断标准：IPC invoke → L3；IPC on（持续推送）→ L4 写 L2；UI 交互态 → L2 transient；组件独享 → L1。

## 2. 信息架构与整体布局

### 2.1 三段式主布局

实现：[AppShell.tsx](../src/renderer/components/layout/AppShell.tsx) + [globals.css](../src/renderer/styles/globals.css) `.view-chat`

```
┌────────────────────── topbar（52px，玻璃质感）──────────────────────┐
├────────┬────┬────────────────────────┬────┬────────────────────────┤
│ sidebar│resi│   main（thread-bg）    │resi│     right-panel        │
│ (17vw) │zer │   HomePage / ChatPage  │zer │   Info/Diff/Files/     │
│ clamp  │6px │                        │6px │   Browser/Terminal/Dev │
│200-280 │    │                        │    │   clamp 260-360        │
└────────┴────┴────────────────────────┴────┴────────────────────────┘
```

- 布局尺寸用 `clamp()` 响应式（`--sidebar-w: clamp(200px,17vw,280px)`、`--right-panel-w: clamp(260px,22vw,360px)`）；拖拽调整后以 CSS 变量 `--aurora-sidebar-w` / `--aurora-right-panel-w` 覆盖。
- **折叠态**：`sb-collapsed` / `crp-collapsed` 类使 grid 对应列塌缩为 0；折叠按钮在顶栏与右面板竖条内。
- **断点联动**：窗口 <1200px 自动折叠右面板、<900px 自动折叠侧栏；用户手动切换后（`manualRef` 置位）断点不再覆盖手动意图。
- **resizer 可拖拽**：左右两条分隔线，`mousedown` + 全局 `mousemove/mouseup`，拖拽范围钳位 `SIDEBAR_WIDTH_MIN~MAX`（左 200-400px，见 [layout-utils.ts](../src/renderer/components/layout/layout-utils.ts)）与 `RIGHT_PANEL_WIDTH_MIN~MAX`（右 260-360px）；拖拽期间 `body.resizing`；元素 `tabIndex=0` + `aria-valuenow` 可聚焦（ARIA 滑块语义）。
- **欢迎页模式**（`welcome-mode`）：主区变为居中 flex 容器，右面板隐藏、右 resizer 隐藏；由 `useWelcomeStore.isWelcomeMode` 驱动。

### 2.2 页面/视图清单

| 视图 | 路由 | 组件 | 说明 |
|---|---|---|---|
| 欢迎页 | `/` | [home.tsx](../src/renderer/routes/home.tsx) | 品牌区 + 居中输入舱 + 项目选择 + 快捷动作 pill |
| 聊天页 | `/chat/:id` | [chat.tsx](../src/renderer/routes/chat.tsx) + [ChatPanel.tsx](../src/renderer/components/chat/ChatPanel.tsx) | 状态条 + 消息列表 + 输入舱 |
| 设置 | 全屏 Sheet（非路由） | [SettingsDialog.tsx](../src/renderer/components/settings/SettingsDialog.tsx) | 左导航 + 右内容 |
| 命令面板 | 覆盖层（非路由） | [CommandPalette.tsx](../src/renderer/components/common/CommandPalette.tsx) | cmdk 全局搜索 |

### 2.3 全局浮层优先级（z-index 体系，`--z-base` → `--z-boundary`）

`z-base(1) < z-surface(2) < z-popover(50) < z-modal(100) < z-toast(110) < z-boundary(999)`。其中 `z-surface` 供面板内容之上的行内浮层（进度条、斜杠建议面板等在同一 stacking context 内竞争）；`z-popover` 是 Radix 浮层统一档（dialog / sheet / dropdown / select / context-menu / tooltip）；`z-modal` 供需压过一切浮层的强制模态（如 AskDialog）；`z-toast` 为通知层（sonner）；`z-boundary` 为层级边界值（skip-link 聚焦等不遮挡内容的最高层）。新增浮层必须复用既有档位，禁止自定义数字（`check:tokens` 卡关裸 `z-*` 数字）。

> ⚠️ **数值真源 = `src/renderer/styles/tokens.css` 的 `--z-*`**（由 `tokens/aurora.json` 经 Style Dictionary 生成）。本节数值须与之一致；改令牌后同步本节。**引用令牌时也只能用真源里存在的名字**——`check:css-vars` 卡关「引用未定义令牌」（2026-09-14 新增门禁，此前 `var(--z-dropdown)` 等 5 处引用不存在的令牌导致声明被静默丢弃）。

## 3. Aurora 2.0 视觉规范

实现：[globals.css](../src/renderer/styles/globals.css)（`@import` 引入 tokens.css 并补充组件级样式）+ [tokens.css](../src/renderer/styles/tokens.css)（**设计令牌真源生成物**，勿手改）+ [index.css](../src/renderer/index.css)

### 3.1 令牌体系（禁止硬编码）

- **颜色**：亮/暗两套完整令牌集（`:root` 与 `.dark` 块）；背景三级深度（L0 `--bg` / L1 `--bg-elev` / L2 `--bg-elev-2` / L3 `--bg-elev-3`）、文字三级明度（`--text` / `--text-dim` / `--text-faint`）、双 accent（青绿主 `--accent:#00b89e` + 蓝色辅 `--accent-2:#2b7fff`）、语义色（success/warning/destructive）、消息气泡、遮罩/玻璃、滚动条、发光阴影（glow-sm/md/lg）、动效缓动。
- **字号**：6 级阶梯 `--font-size-2xs(10) / xs(11) / sm(12) / base(13) / md(14) / lg(16)`；旧 `--fs-*` 别名仅兼容保留。
- **间距**：`--sp-1` ~ `--sp-7`（4px 步进，16px 基准）。
- **圆角**：`--radius: 0.625rem`（10px）。
- **字体**：`--font-sans / --font-serif / --font-mono`；侧栏/设置标题用衬线（文学风），元信息与状态用等宽。
- 通过 `@theme inline` 映射为 Tailwind 工具类（`bg-background` / `text-muted-foreground` / `text-primary` 等），组件中**禁止**出现颜色字面量与任意像素值。

### 3.2 主题机制

- 三值主题：`light / dark / system`（默认 `dark`），持久化于 [settings-store.ts](../src/renderer/stores/persistent/settings-store.ts)。
- [ThemeProvider.tsx](../src/renderer/providers/ThemeProvider.tsx) 仅做副作用：`<html class="dark">` 切换 + `matchMedia('(prefers-color-scheme: dark)')` 监听（仅 system 模式）。
- **入口不一致说明（已知）**：顶栏主题按钮在 `light ↔ dark` 两态间切换；全局快捷键 `Ctrl+Shift+T` 在 `light → dark → system` 三态间循环。两者行为不同，属现状，改动需统一。
- 主题切换禁止直接操作 DOM class，一律走 `settings-store.setTheme()`。

### 3.3 对比度标准（实测值）

| 位置 | 要求 | 实测 |
|---|---|---|
| 正文/激活导航（深浅两主题） | ≥4.5:1 | `text-foreground` 16.1:1 ✅ |
| 次级文字 `text-muted-foreground` | ≥4.5:1 | 浅色 5.39:1（`--text-faint #5d6779`）✅ |
| 主按钮 `--primary` 上的前景 | ≥4.5:1 | `--on-accent #001814` 7.6:1 ✅ |
| 深色下辅助文字 | ≥4.5:1 | `--text-faint` 在 `--bg` 上约 6.5:1 ✅ |

历史教训（勿回退）：硬编码 `text-stone-*` 曾导致审批卡标题深色 1.23:1；浅色导航 `text-primary` 青色 2.51:1 —— 均不达标，已全部 token 化修复。

### 3.4 氛围层与动效

- `body::before`：双 accent 渐变光晕 + 技术网格 + 扫描线；`body::after`：SVG 噪点纹理（mix-blend-mode）。
- 主区 `thread-bg paper-texture`：多层光晕 + 纸张噪点。
- 顶栏：`backdrop-filter: blur(16px) saturate(1.4)` + 底部双 accent 渐变发光刻度线。
- 动画统一 `tw-animate-css`；消息入场 `motion`（opacity + y:6 → 0，`smoothEaseOut`）；流式状态点 `animate-pulse-soft`；自定义动画必须在 `globals.css` 定义并复用缓动变量。
- 实验开关：`experimental.scanlines` 控制扫描线视觉叠加（默认关）。

## 4. 核心交互流程

### 4.1 会话生命周期（侧栏）

实现：[Sidebar.tsx](../src/renderer/components/layout/Sidebar.tsx) + [thread-item.tsx](../src/renderer/components/layout/thread-item.tsx) + [folder-label.tsx](../src/renderer/components/layout/folder-label.tsx)

| 能力 | 交互 | 数据/持久化 |
|---|---|---|
| 新建会话 | 头部按钮；文件夹 hover 的 `+` 按钮在指定文件夹内新建 | 复用最近 workingDir → 欢迎页可再改 |
| 切换会话 | 点击会话项 → `/chat/:id` | L2 `activeSessionId` |
| 分组 | 按 `workingDir` basename 自动分组 | 服务端顺序 |
| 文件夹折叠 | 点击 label 箭头 | `sidebar-pref-store`（localStorage 持久化） |
| 拖拽排序 | 会话项 `ti-dot` 拖拽，同文件夹内重排（4px 位移激活；跨文件夹被过滤） | 覆盖顺序写入 `orderOverrides`（localStorage） |
| 置顶 | 更多菜单「置顶/取消置顶」 | `session.pinned` 真实字段 |
| 重命名 | 双击标题 或 更多菜单 → 内联 input（Enter 提交 / Esc 取消 / blur 提交） | `session:rename` |
| 删除 | 更多菜单「删除」；删除激活会话自动回首页 | `session:delete` |
| 打开文件树 | hover 文件夹树按钮 → 切换侧栏视图 + 激活会话 | `ui-store.sidebarView` |

**诚实标注**：搜索框为**真实过滤**（标题/workingDir 大小写不敏感 includes + 300ms 防抖 + 命中项 2s 高亮环，Sidebar.tsx）；「归档」tab 计数恒 0 且空态（无归档后端）；右键菜单仅实现有后端支撑的 2 项（重命名/删除）+ 置顶，参考项目的归档/复制/压缩等 9 项能力**不适用（NONE）**。

### 4.2 欢迎页 → 会话创建

实现：[home.tsx](../src/renderer/routes/home.tsx) + [welcome-store.ts](../src/renderer/stores/transient/welcome-store.ts)

1. 品牌区 `Code with TRAE`；输入舱居中（max-width 720px），含项目选择条 + 模型选择器。
2. **项目选择**：下拉展示历史目录（`session:listRecentDirs`，含相对时间）、「未选择项目」、「浏览其他目录…」（原生目录选择器，取消保持菜单打开）。无历史目录时自动取第一个（仅当用户未主动选择时）。
3. **发送校验**：未选目录 → `toast` 提示 + 自动展开项目下拉（不弹原生对话框）。
4. **创建成功**：`session:create` → 激活 + 跳转 `/chat/:id`；首条消息经 `sessionStorage` 暂存（key 契约 `lib/pending-message.ts`），ChatPanel 挂载后消费即移除并自动发送（`consumePendingMessage` 幂等，StrictMode 双挂载/会话重进不重复发送）。
5. **快捷 pill ×4**（应用开发/项目理解/创意点子/工具知识）：点击仅**预填**输入框并聚焦，不自动发送。
6. 创建中 `isPending` 禁用发送按钮与 pill，防重复提交。

### 4.3 聊天输入舱

实现：[ChatInput.tsx](../src/renderer/components/chat/ChatInput.tsx)（630 行，交互最密集的组件）

| 交互 | 行为 |
|---|---|
| 发送 | `Enter`；`Shift+Enter` 换行；`Ctrl/Cmd+Enter` 不发送（原样换行语义） |
| 停止 | 流式中按钮变「停止」；`Esc` 全局可中断（window 级监听，textarea 失焦也生效） |
| 自动增高 | 1 → 8 行（240px 封顶），超出滚动 |
| 拖拽调高 | 顶部手柄 `ns-resize`：向上拉高，钳位 [40, 460]；**双击重置**为自动高度；键盘 `↑/↓` 20px 步进 |
| 字符计数 | trim 后显示，>2000 变警告色（`aria-live`） |
| 长度上限 | 8000 字符拦截（toast 报错） |
| 附件 | `@` 按钮（原生多选文件）→ chip 展示（可移除，去重）→ 发送时 `file:read` 读取（≤4000 字符截断，失败仅标注文件名不阻断） |
| 斜杠命令 | 输入 `/` 弹建议（/help /new /clear /compact /models /interrupt /goal）；`Tab/Enter` 应用，`Esc` 关闭；带 action 的命令点击直接执行：/new 回欢迎页、/clear 清空消息、/help 打开快捷键帮助、/interrupt 真实中断、/goal 预填输入框、/models 打开项目栏模型选择下拉（受控）、/compact 手动压缩会话上下文（主进程按模型窗口预算裁剪 compressByTokenBudget → 整体落库 → 本地消息态同步 + toast 结果） |
| 草稿 | 按会话持久化文本+附件（draft-store）；发送成功清除；切换会话自动恢复 |
| 流式中输入 | **不禁用** textarea，允许预输入下一条（停止按钮期间可打字） |

工具栏提示恒定展示 `⏎ 发送 · ⇧⏎ 换行`，流式中追加 `Esc 中断`。

### 4.4 消息渲染与流式输出

实现：[ChatMessageList.tsx](../src/renderer/components/chat/ChatMessageList.tsx) + [message-item.tsx](../src/renderer/components/chat/message-item.tsx) + [streaming-footer.tsx](../src/renderer/components/chat/streaming-footer.tsx)

- **智能自动滚动**：距底部 ≤80px 视为"在底部"跟随流式；用户上翻时显示「滚动到底部」按钮，新消息到达按钮带红点（`has-new`）。
- **消息导航轨**：≥2 条用户消息时右侧点状导航（圆点代表用户消息，`MAX_NAV_DOTS=10` 按比例映射），点击居中滚动。
- **消息形态**：user 玻璃渐变气泡靠右；assistant 头像「C」+ 角色行（`assistant · 模型名`）+ 开放排版；system 居中淡灰小字。
- **parts 渲染**：
  - text → Markdown（GFM + shiki 代码高亮，双主题跟随）；
  - reasoning → 折叠推理块（accent 左光条；默认折叠由 `experimental.reasoningCollapsed` 控制，用户显式开合后该条消息记忆化优先）；
  - tool → 可折叠工具卡片（默认折叠；状态 pending/running/success/error 徽章；input/output/error 代码块 ≤200 字符）；
  - edit_file / write_file → **FileChangeCard** diff 可视化卡片；
  - file → 📎 附件卡；step-start → 步骤分隔线。
- **流式尾部**：typing-indicator（三 accent 点弹跳）+ 「…」占位。
- **消息操作**（assistant hover 显示）：复制 + 重新生成（`regenerate` 截断该消息及后续重新请求）；流式中禁用。
- 性能：普通滚动渲染（已移除 Virtuoso，规避 React 19 下空→非空更新时序 bug）；`MessageItem` 按 id 记忆化，流式仅重渲染变化消息。

### 4.5 工具调用与审批

实现：[inline-approval-card.tsx](../src/renderer/components/agent/inline-approval-card.tsx) + [approval-preview.tsx](../src/renderer/components/agent/approval-preview.tsx)

- **就地审批不弹窗**：pending 审批内联展示在消息列表上方（`role="alert"` + 左 warn 边条）。
- **三按钮**：拒绝 / 白名单 / 批准（危险工具批准按钮红色）。白名单 = 批准 + `rememberDecision`：按「工具 + 入参哈希」记忆 5 分钟（TTL 过期后重新询问），另有持久化命令白名单（userData/whitelist.json）。
- **三态回显**：pending（操作按钮）/ approved（绿徽章）/ rejected（红徽章），最近一条已决审批保留回显。
- **真实链路**：按钮 → 更新 approvals-store + `agent:approval:response` 回传主进程（PermissionService 继续/中止工具）；浏览器模式仅本地态。
- 结构化预览：按工具类型渲染——write_file/edit_file 为 ReactDiffViewer 双栏 diff、run_command 为命令预览、git 系列为专用预览；其余类型（apply_patch/delete_file/install_package/external_call）仅红色图标警示（无 JSON 预览）。

### 4.6 会话内搜索

实现：[use-conversation-search.ts](../src/renderer/hooks/use-conversation-search.ts) + [conversation-search-bar.tsx](../src/renderer/components/chat/conversation-search-bar.tsx)

- 入口：状态条放大镜按钮；搜索栏含查询框 + 匹配计数（当前/总数）+ 上一条/下一条 + 关闭。
- 匹配消息滚动居中 + 高亮（`search-highlight`）；关闭后清除高亮。

### 4.7 文件树与文件查看器

实现：[FileTreePanel.tsx](../src/renderer/components/file-tree/FileTreePanel.tsx) + [FileTreeNode.tsx](../src/renderer/components/file-tree/FileTreeNode.tsx) + [node-menu.tsx](../src/renderer/components/file-tree/node-menu.tsx) + [FileViewerPanel.tsx](../src/renderer/components/file-tree/FileViewerPanel.tsx)

- 入口：会话项 hover 文件夹树按钮 / 命令面板「打开文件树」；头部返回按钮回会话列表；刷新按钮重拉**根目录 + 全部已展开目录**（watch 事件流之外的兜底）。
- 工具栏新建文件/目录（根目录）；节点 hover「…」更多菜单（node-menu.tsx）：目录 = 新建文件/新建目录/复制路径/重命名/删除，文件 = 复制路径/重命名/删除；删除为危险红字菜单项，复制成功 toast 反馈。
- 内联编辑：新建/重命名以行内 input 呈现（Enter 提交 / Esc 取消）。
- **文件查看器**（右面板「文件」tab 内嵌面板，非独立 Dialog）：shiki 语法高亮（双主题跟随）；只读/编辑双模式（textarea + shiki 叠加高亮，零新依赖）；保存走全局 `Ctrl+S`（settings.shortcuts.saveFile 可自定义，经 file-viewer-store 保存桥接转发到当前编辑实例）；**脏数据保护**：退出编辑模式与切换文件前均需确认（取消保持原内容）；路径面包屑 + 行数 + 复制按钮；语言按扩展名推断。
- 文件树数据：IPC `file:list` + `file:watch:event` 实时同步（监听失效有提示文案）。

### 4.8 右面板（会话上下文面板）

实现：[DevPanel.tsx](../src/renderer/components/layout/DevPanel.tsx) + [right-panel-panes.tsx](../src/renderer/components/layout/right-panel-panes.tsx)

| Tab | 内容 | 数据源 |
|---|---|---|
| 会话详情 | 计划待办（task 列表）、引用文件（read_file 调用去重）。会话目标已迁移至对话区输入框上方的 GOAL 栏（ChatPanel），此处不重复 | `task:list` / tool-store |
| 文件变更 | 本轮 edit_file/write_file 调用记录（UnifiedDiffView 双栏 diff） | tool-store |
| 文件 | 文件查看器面板本体（FileViewerPanel：高亮/编辑/保存/复制）；入口 = 文件树点击、命令面板文件命令、引用文件跳转 | `file:read` |
| 浏览器 | 内嵌浏览器（懒加载） | — |
| 终端 | xterm.js 终端（懒加载，~200KB chunk 切到才加载） | `terminal:*` IPC |
| 开发者 | Git / 日志 / 指标 / 检查器（调试工具收纳） | `git:*` / `logs:read` / metrics / inspector |

- 终端：按终端实例建 PTY（同一会话可多开终端 tab）；输出直接 `xterm.write`（use-terminal-bridge 并行写 store buffer 兜底）；`ResizeObserver` 防抖 100ms 同步尺寸；切到终端 tab 无实例时自动创建；退出后保留输出并标「已结束」；关闭按钮 kill PTY。
- Git：**纯只读**（分支 + ahead/behind + 变更文件列表 + unified diff），不提供 commit/push，避免误操作主仓库。

### 4.9 命令面板

实现：[CommandPalette.tsx](../src/renderer/components/common/CommandPalette.tsx)

- 入口：`Ctrl+P` / `Ctrl+K` / 顶栏文字胶囊；集中受控于 `ui-store.paletteOpen`。
- 分组：操作（7 条：新建会话/切换主题（三态循环）/打开设置/切换侧栏视图/折叠侧栏/折叠右面板/打开终端）、文件（≤50 条，来自文件树，选中直达查看器）、会话（≤20 条，置顶优先 + updatedAt 倒序）。
- 模糊搜索：fuse.js（threshold 0.4，标题+分组字段）；`↑↓` 导航 / `Enter` 执行 / `Esc` 关闭；空结果提示；底部 kbd 提示条。

### 4.10 设置全屏页

实现：[SettingsDialog.tsx](../src/renderer/components/settings/SettingsDialog.tsx) + `sections/`（20 个 section 文件）

- **形态**：全屏 Sheet（右上 140px 透明拖拽区避让窗口控件）；左上「← 返回」；打开时重置到「模型服务」分区（避免停留深层分区）。
- **导航**：5 组 15 项，`role="tablist"` + `↑↓` 方向键循环；激活项 = accent 2px 左竖条（`border-l-[color:var(--accent)]`）+ `text-foreground font-medium`（浅色模式对比度达标）。
- **分区能力矩阵**：

| 分区 | 能力 | 状态 |
|---|---|---|
| 模型服务 | 10 家提供商行（配置状态徽标 + 展开编辑 API Key：显示/隐藏/保存/删除）；运行时模型增删（modelId/provider/baseUrl）；模型参数（默认模型/温度/思考强度 off-low-medium-high）——温度全链路透传 agent:run（schema→handler→buildGenerationOptions temperatureOverride），DeepSeek 思考模型按官方限制忽略采样参数；审批权限（审批模式/白名单） | 已实现 |
| MCP | server 列表（名称/状态徽章/工具数/最后一次错误信息）+ 添加表单 + 启动/停止 | 已实现 |
| 技能 | 已学技能列表 + 描述学习（learn-skill-agent）+ 移除 | 已实现 |
| 通用 | 语言切换（中/英立即生效）；编辑器（字号 12/14/16 真实消费于消息区 + vim 模式：h/j/k/l 移动 · w/b 词首 · 0/$ 行首尾 · x 删字符 · dd 删行 · i/a/I/A 插入 · Esc 切换，输入舱 NORMAL/INSERT 徽章；不支持 y/p/v/u 与数字前缀——设置页如实标注）；快捷键（ShortcutPicker 录制 6 项）；系统提示词编辑（保存即生效，空串回退内置）；数据管理（导出/打开数据目录）；遥测级别（重启生效） | 已实现 |
| 工作树 | 当前工作目录 + 展开节点数（只读状态） | 已实现（配置项规划中） |
| 浏览器 | 右面板「浏览器」tab 为 iframe 预览工具的说明页 | 说明页（配置项规划中） |
| 实验 | scanlines 扫描线（AppShell 根级 .scanlines-overlay 条件渲染，--text 令牌）/ 推理块默认折叠（message-item 消费） | 已实现（原型其余项不展示假开关） |
| 关于 | 版本号 / Electron-Node-Chromium 运行时 / 打开数据目录 | 已实现 |
| 账号 / 移动端 / 插件 / hooks / 命令 | 「🚧 规划中」占位（诚实标注；IM 渠道真实功能保留在移动端分区） | 占位 |

- 每个 pane 独立 `SectionErrorBoundary`（`resetKeys=[activeSection]` 切分区自动重置错误态）：单 pane 崩溃局部降级，不拖垮整个设置页。

### 4.11 全局反馈通道

| 通道 | 触发 | 表现 |
|---|---|---|
| 限流横幅 | 429（rate-limit-store） | 聊天区顶部横幅 |
| 内联审批卡 | pending 审批 | 消息列表上方内联卡 |
| 中断提示条 | `session.lastRunStatus` 异常（崩溃恢复） | 顶部 amber 提示，可关闭（会话内不再显示） |
| 更新提示 | update 事件 | toast（无 DOM） |
| 协议校验 | 主/渲染层版本错配 | 提示重启（P0 契约） |
| Toast | 错误/成功/引导 | sonner，`z-toast-stack` 最高优先级 |

## 5. 反馈与异常状态

### 5.1 状态指示体系

- 状态条（聊天页顶部）：`workingDir basename · [状态点] READY/RUNNING/THINKING/ERROR/IDLE · token 用量`（悬浮显示 input/output/total 明细；streaming 时状态文字 accent 色 + 脉冲点）。
- 输入舱底部 stats-bar：`状态 · 消息数 · Token`。
- 流式期间输入框按钮 → 停止（error 色 + 红色发光）。

### 5.2 异步五态契约（AsyncBoundary）

实现：[AsyncBoundary.tsx](../src/renderer/components/common/AsyncBoundary.tsx) + [use-async-view.ts](../src/renderer/hooks/use-async-view.ts)

```
loading（骨架屏，首载 >200ms 才显示防闪烁）→ refreshing（保留旧数据 + 顶部细进度条）
→ ready → empty（EmptyState）／ error（可操作：重试 + 错误码恢复动作）
```

- 错误文案约定：`[ERROR_CODE] message` 前缀解析 → i18n 本地化；解析失败回退原始消息。
- 错误恢复动作（`error-actions.ts`）：如 `AI_CONFIG_ERROR` → 「去配置」按钮直接打开设置页。
- 空态规范：有 CTA 才放按钮（侧栏空态无 CTA，因头部已有「新建会话」，避免冗余）。

### 5.3 错误边界三层体系

| 层 | 组件 | 表现 |
|---|---|---|
| App 级 | [AppErrorBoundary.tsx](../src/renderer/components/common/AppErrorBoundary.tsx) | 全屏兜底 + Sentry 自动上报 + 「重新加载」/「发送报告」（显式补报） |
| 路由级 | [root.tsx](../src/renderer/routes/root.tsx) RootErrorBoundary | 状态码/错误消息 + 重新加载按钮 |
| 组件级 | [SectionErrorBoundary.tsx](../src/renderer/components/common/SectionErrorBoundary.tsx) | 侧栏 / 主内容 / 右面板 / 设置 pane 局部降级 |

### 5.4 浏览器模式守卫

所有 `window.api` 调用点均有运行时守卫（`window.api === undefined` 时返回空数据/静默跳过），保证 `pnpm dev` 浏览器预览不崩溃（模型清单空、usage 0 值骨架、附件选择静默跳过等）。

## 6. 键盘交互与可访问性

### 6.1 快捷键总表

来源：[use-keyboard-shortcuts.ts](../src/renderer/hooks/use-keyboard-shortcuts.ts)（Windows/Linux 默认；macOS 自动换 `Meta`）：

| 快捷键 | 动作 | 可配置 |
|---|---|---|
| `Ctrl+P` / `Ctrl+K` | 命令面板 | ✅ ShortcutPicker |
| `Ctrl+,` | 设置 | ✅ |
| `Ctrl+N` | 新建会话（欢迎页 + 跳转首页，与侧栏新建一致） | ✅ |
| `Ctrl+S` | 保存（编辑态文件查看器：全局快捷键 → file-viewer-store 保存桥接，尊重自定义键位） | ✅ |
| `Ctrl+F` | 文件+会话统一搜索（FuzzySearchDialog，非命令面板） | ✅ |
| `Ctrl+Shift+T` | 切换主题（三态循环 dark→light→system，与顶栏/命令面板/账户菜单一致） | ✅ |
| `Ctrl+B` / `Ctrl+1` | 折叠/展开侧栏 | 固定 |
| `Ctrl+J` / `Ctrl+2` | 折叠/展开右面板 | 固定 |
| `` ` ``（反引号） | 打开终端（展开右面板 + 切终端 tab） | 固定 |
| `Shift+/`（即 `?`） | 快捷键帮助 | 固定 |
| `Enter` / `Shift+Enter` | 发送 / 换行 | 固定 |
| `Esc` | 流式中断 / 关闭浮层 | 固定 |
| `Alt+←` | 聊天页返回（按钮 title 提示） | 固定 |

### 6.2 键盘可达性

- 跳过导航链接（WCAG 2.4.1）：`sr-only` 聚焦显示，锚点 `#main-content`。
- 会话项/文件树节点：`Enter/Space` 激活；侧栏 tabs 走 WAI-ARIA tabs 模式（←/→/Home/End 移动焦点并激活 + roving tabindex）；模型选择菜单 roving focus（↑/↓ 循环 · Home/End 首尾 · 打开时聚焦选中项）；resizer `tabIndex=0` + ARIA 滑块语义 + 方向键 16px 步进（Home/End 极值）。
- 设置导航：`role=tablist` + 方向键循环；斜杠建议 `role=listbox` + `Tab/Enter/Esc`。
- 输入框拖拽手柄：键盘 `↑/↓` 20px 步进（等价拖拽）。
- 所有图标按钮有 `aria-label`；状态点 `role=status`；错误 `role=alert`；加载 `aria-busy`。

### 6.3 ARIA 语义约定

`tablist/tab`（设置导航、侧栏 tabs）、`tree`（文件树）、`dialog`（命令面板/查看器）、`listbox`（斜杠建议）、`menu`（folder 下拉）、`status`（状态指示）、`alert`（审批卡/错误）。

## 7. 国际化

实现：[i18n/](../src/renderer/i18n/)（i18next，`zh-CN`（默认）/ `en` 双语言）

- 命名空间：`common`（UI 文案）+ `errors`（错误码文案）；`check:i18n --strict` 已并入 check:static 门禁（0 缺失/0 冗余/双语一致卡关；checker 支持 t(labelKey) 常量间接引用解析）。
- 语言切换立即生效（`changeLanguage`）；设置页语言行持久化于 settings-store 关联项。
- 快捷键键位（kbd）与错误码为技术标识不本地化；时间相对化文案走 `formatRelativeTime(path, t)`。
- **新文案必须走 i18n**：`t('key')` 渲染，禁止中文字面量硬编码（例外：纯技术标注如「加载中…」需登记 key）。

## 8. 实事求是清单（已实现 vs 占位 vs 不适用）

| 能力 | 状态 | 说明 |
|---|---|---|
| 会话 CRUD / 置顶 / 拖拽排序 / 文件夹分组 / 重命名 | ✅ 已实现 | 后端真实持久化 |
| 草稿持久化（文本+附件） | ✅ 已实现 | 发送即清 |
| 内联审批 + 白名单 | ✅ 已实现 | `rememberDecision` = 工具+入参哈希 5 分钟记忆 + 持久化命令白名单 |
| 会话内搜索 / 消息导航轨 / 重新生成 | ✅ 已实现 | — |
| 命令面板（操作/文件/会话） | ✅ 已实现 | — |
| 文件树实时同步 + 节点操作菜单 + 查看器编辑 | ✅ 已实现 | watch 事件流；节点菜单 = 新建/重命名/删除/复制路径 |
| Git 只读面板 / 终端 PTY / 用量统计 | ✅ 已实现 | — |
| 侧栏搜索过滤 | ✅ 已实现 | 标题/目录 includes 过滤 + 300ms 防抖 + 2s 高亮 |
| 欢迎页首条消息透传 | ✅ 已实现 | sessionStorage 暂存 → ChatPanel 挂载消费即移除并发送（幂等） |
| 主题三态（亮/暗/跟随系统） | ✅ 已实现 | 快捷键/顶栏/命令面板循环 + 账户菜单三选一 |
| 全局 Ctrl+S 保存桥接 | ✅ 已实现 | settings 自定义键位 → file-viewer-store → 编辑态查看器 |
| 归档 tab | ⚠️ 空态 | 计数恒 0，无归档后端 |
| 设置：账号/插件/hooks/命令/移动端 | ⚠️ 规划中 | 「🚧 规划中」诚实占位 |
| 斜杠命令 /models /compact | ✅ 已实现 | /models 打开模型选择下拉；/compact 窗口感知压缩 + 落库 + 本地态同步 |
| vim 模式 | ✅ 已实现 | 输入舱最小可用子集（移动/删除/插入），设置页如实标注不支持项 |
| 退出登录 / 云端账户 | ❌ NONE | 无登录后端（诚实不提供） |
| Git commit/push UI | ❌ NONE | 面板纯只读（防误操作） |

## 9. UX 验收清单（生产可用）

新功能/修复合入前的 UI 验收项（对照本规范逐条自检）：

**布局与视觉**
- [ ] 无硬编码颜色/像素值；全部走 Aurora 令牌与 Tailwind 工具类
- [ ] 深浅两主题截图对比：文字对比度 ≥4.5:1（WebAIM 或 getComputedStyle 实测）
- [ ] 折叠态/断点（<1200px / <900px）下布局不破；手动折叠不被断点覆盖
- [ ] 新增浮层使用既有 z-index 档位

**交互与状态**
- [ ] 异步数据走 AsyncBoundary 五态（loading/refreshing/error/empty/ready），首载防闪烁 200ms
- [ ] 错误展示 `[CODE]` 前缀 + i18n 文案 + 可操作动作（重试/去配置）
- [ ] 所有 `window.api` 调用点有浏览器模式守卫
- [ ] 长任务有进行中反馈（骨架/进度/状态点）；可中断操作有停止入口（Esc 兜底）

**可访问性与键盘**
- [ ] 图标按钮有 `aria-label`；新对话框有 title/description
- [ ] 全局快捷键注册走 `useKeyboardShortcuts`（配置驱动）；帮助表与绑定一致
- [ ] 列表/树类组件键盘可达（Enter/Space 激活，方向键导航）

**文案与 i18n**
- [ ] 新 UI 文案走 i18n（zh-CN/en 两语言同步补齐）
- [ ] 占位/规划功能明确标注，不伪造假 UI

**性能**
- [ ] 重组件（xterm/浏览器/高亮）保持懒加载；列表滚动普通渲染（勿引入 Virtuoso）
- [ ] 流式消息仅变化项重渲染（MessageItem memo）

## 附录：关键文件索引

| 关注点 | 文件 |
|---|---|
| 布局/折叠/resizer | `components/layout/AppShell.tsx` |
| 顶栏 | `components/layout/Topbar.tsx` |
| 侧栏/会话列表 | `components/layout/Sidebar.tsx`、`thread-item.tsx`、`folder-label.tsx` |
| 欢迎页 | `routes/home.tsx` |
| 聊天 | `components/chat/ChatPanel.tsx`、`ChatInput.tsx`、`ChatMessageList.tsx`、`message-item.tsx`、`Markdown.tsx` |
| 审批 | `components/agent/inline-approval-card.tsx`、`approval-preview.tsx` |
| 命令面板 | `components/common/CommandPalette.tsx` |
| 文件 | `components/file-tree/FileTreePanel.tsx`、`FileTreeNode.tsx`、`node-menu.tsx`、`FileViewerPanel.tsx` |
| 右面板 | `components/layout/DevPanel.tsx`、`right-panel-panes.tsx` |
| 终端 | `components/terminal/TerminalPanel.tsx` |
| Git | `components/git/GitPanel.tsx` |
| 设置 | `components/settings/SettingsDialog.tsx` + `sections/*` |
| 主题/令牌 | `providers/ThemeProvider.tsx`、`styles/globals.css` |
| 状态管理 | `stores/persistent/*`、`stores/transient/*` |
| 错误体系 | `components/common/AppErrorBoundary.tsx`、`AsyncBoundary.tsx`、`SectionErrorBoundary.tsx`、`lib/error-actions.ts` |
| i18n | `i18n/locales/zh-CN/*.json`、`i18n/locales/en/*.json` |
