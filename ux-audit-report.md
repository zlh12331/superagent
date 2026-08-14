# 代码级 UX 审计报告 — docs/design/08-ux-guidelines.md vs src/renderer 实测

审计方式：仅静态 read/grep/glob 核查（未跑 build/test）。证据均为 文件:行号。
侧栏/欢迎页/ChatInput/消息渲染/会话内搜索/文件树/命令面板/设置页已本人逐文件核实；审批/命令面板/右面板/设置页另有并行子代理交叉复核（结论一致）。

## A. 【文档失实清单】文档声称已实现但代码中不存在/行为不同（按严重度排序）

### A1. 欢迎页首条消息「自动发送」是半成品 —— 写 sessionStorage 但全仓无人读取（功能性 bug）
- 文档原话（4.2）：首条消息经 sessionStorage 暂存，ChatPanel 挂载后自动发送（避免未挂载调用）
- 证据：写入 src/renderer/routes/home.tsx:204  sessionStorage.setItem("welcome:pending-message:"+sessionId, ...)；全仓 grep pending-message 仅此一处，ChatPanel.tsx/chat.tsx/use-agent.ts 均无 getItem 消费者
- 结论：欢迎页首条消息永远不会被发送（只建会话、消息丢失），「自动发送」未实现。
- ✅ 已修复：key 契约统一到 lib/pending-message.ts（consumePendingMessage 读取即移除、幂等），ChatPanel 挂载后消费并自动发送（ChatPanel.tsx:180-187）；单测 pending-message.test.ts（5 例）。

### A2. 文件树节点「更多菜单：新建/重命名/删除/复制路径」 —— 组件不存在，且重命名/删除/复制全部不可达
- 文档原话（4.7）：节点 hover「更多」菜单：新建文件/新建目录/重命名/删除/复制路径
- 证据：FileTreeNode.tsx 仅 293 行，:279-293 的「更多操作」说明只是注释；:5 声称拆出的 node-menu.tsx 全库不存在；startRename（file-tree-store.ts:246）、deleteEntry（use-file-tree-ops.ts:105）、copyToClipboard（FileTreeNode.tsx:63）全仓零调用 → 内联重命名（FileTreeNode.tsx:171-176）因 renamingPath 永不被置位而不可达；删除/复制路径无任何 UI 入口；i18n「复制路径」(common.json:611) 与 CSS .ft-more-btn (globals.css:3018) 均悬空
- 结论：文档宣称的 5 项菜单能力实际只有「根目录新建」可达，其余 4 项不可达（后端 IPC file:delete/rename 与 hooks 全就绪，只差 UI 触发器）。
- ✅ 已修复：新增 node-menu.tsx（NodeMenu 组件，hover「…」按钮 + DropdownMenu），文件/目录节点均接入：目录=新建文件/新建目录/复制路径/重命名/删除，文件=复制路径/重命名/删除；startRename/deleteEntry 死代码激活，悬空 CSS .ft-more-btn 与 i18n 键复用；copyToClipboard 死导出移除。

### A3. 侧栏搜索「仅 UI 无过滤」 —— 实际有真实过滤 + 防抖高亮（文档反向失实）
- 文档原话（4.1/8）：搜索框仅 UI（无过滤逻辑）；侧栏搜索过滤 ⚠️ 仅 UI
- 证据：Sidebar.tsx:111-117  filteredSessions = sessions.filter(title/workingDir 大小写不敏感 includes)；:135-166 300ms 防抖 + 匹配项 2s 高亮环（:211 ring-[var(--accent)]/40）
- 结论：过滤已实现（还带高亮），文档停留在旧版本。

### A4. 右面板「会话详情 = goal+task+引用文件」 —— goal 已迁走
- 文档原话（4.8）：会话详情 | 会话目标（goal 列表 + 清除 ×）、计划待办（task 列表）、引用文件 | goal:list / task:list / tool-store
- 证据：right-panel-panes.tsx:7 注释「会话目标已迁移至对话区输入框上方（ChatPanel 目标栏），右面板不再重复展示」；InfoPane（:40-142）只渲染 task:list（:44-59）+ read_file 引用文件去重（:63-80）；goal.list/clear 调用在 ChatPanel.tsx:181/228
- 结论：会话详情 tab 无 goal 列表/清除 ×。

### A5. 右面板「文件 = 最近修改文件列表」 —— 实际是查看器面板本体
- 文档原话（4.8）：文件 | 最近修改文件列表 → 点击打开 FileViewerDialog | tool-store
- 证据：DevPanel.tsx:235 文件 tab 渲染 FileViewerPanel（懒加载）；AppShell.tsx:358 注释「文件查看器已改为右面板文件 tab」；全仓无 recent-files 组件；数据源 file:read 非 tool-store
- 结论：「最近修改文件列表」不存在。

### A6. 设置「温度」参数 —— 死存储，发送路径零消费
- 文档原话（4.10）：模型参数（默认模型/温度/思考强度 off-low-medium-high）| 已实现
- 证据：model-params-section.tsx:40-50 写 ai.temperature；全仓 grep：渲染层仅 settings-store 存储，ChatPanel.tsx:166-173 / use-agent.ts / agent.handler 发送路径均不读取；main 侧只消费模型级 generationConfig.temperature（generation-options.ts:61-62）
- 结论：温度滑块改了不生效。
- ✅ 已修复：全链路透传——AgentRunReqSchema 增 temperature（0-2）、agent.handler 条件展开、StartAgentOptions 增字段、buildGenerationOptions 增 temperatureOverride（用户值 > 模型级 generationConfig.temperature；DeepSeek 思考模型按官方限制忽略采样参数）；渲染层 use-agent.ts 读 ai.temperature → transport.configure；单测 generation-options.test.ts 增 2 例。

### A7. 设置「系统提示词保存即生效」 —— 保存了但永不进入对话
- 文档原话（4.10）：系统提示词编辑（保存即生效，空串回退内置）
- 证据：prompt-section.tsx:36-41 保存真实、main 支持覆盖（agent-service.ts:404-407）、transport 支持（ipc-agent-transport.ts:186）；但 ChatPanel.tsx:166-173 调 useAgentWithIpc 只传 {id, workingDir, messages, onError}，不读 ai.systemPrompt（use-agent.ts:95 仅读 thinking）
- 结论：自定义系统提示词永不生效（settings-store.ts:52 注释「会透传」同失实）。
- ✅ 已修复：use-agent.ts 读取 settings ai.systemPrompt（trim 空串回退主进程内置默认），经 transport.configure 注入 agent:run；显式 options.systemPrompt 优先级最高。

### A8. 实验「scanlines」 —— 假开关，零消费且注释谎称已接入
- 文档原话（4.10）：实验 | scanlines 扫描线 / 推理块默认折叠 | 已实现
- 证据：experimental-section.tsx:31-36 开关仅写 settings-store；全仓 grep scanlines 无消费方，也无 .scanlines-overlay CSS；:4-8 注释「消费方已接入」失实
- 结论：scanlines 开关无任何效果（reasoningCollapsed 是真的：message-item.tsx:488-491）。
- ✅ 已修复：AppShell 根容器条件渲染 .scanlines-overlay（pointer-events:none 纯视觉层），globals.css 新增扫描线样式（走 --text 令牌，无裸色）；开关生效。

### A9. 审批「结构化预览 JSON」 —— JSON 预览不存在
- 文档原话（4.5）：结构化预览：按工具类型渲染（diff 双栏 / JSON）
- 证据：approval-preview.tsx 只有 write_file/edit_file ReactDiffViewer 双栏 diff（:82-133）、run_command 命令预览（:45-58）、git 系列预览（:152-240）；:138-140 明确 apply_patch/delete_file/install_package/external_call 返回 null；全仓无 JSON 预览
- 结论：JSON 预览未实现（危险类型仅红色图标警示）。

### A10. 命令面板入口「Shift+/」 —— 实际绑定的是快捷键帮助
- 文档原话（4.9）：入口：Ctrl+P / 顶栏文字胶囊（唯一入口）/ Shift+/（错误动作）
- 证据：use-keyboard-shortcuts.ts:141  shift+Slash → onOpenShortcutHelp → AppShell.tsx:181 → ShortcutHelpDialog（6.1 反而正确）；ui-store.ts:19 / AppShell.tsx:139 注释「Shift+/ 命令面板入口」同为过期信息
- 结论：Shift+/ 打开的是帮助对话框。

### A11. 快捷键表「Ctrl+Shift+F 搜索文件（等效命令面板）」 —— 键位与动作都错
- 文档原话（6.1）：Ctrl+Shift+F | 搜索文件（目前等效打开命令面板）
- 证据：默认键是 Ctrl+F（settings-store.ts:196 searchFile: MOD+F）；AppShell.tsx:172 onSearchFile → setFuzzyOpen(true) 打开 FuzzySearchDialog（独立文件+会话统一搜索，fuzzy-search-dialog.tsx:5-9），非命令面板

### A12. 「Ctrl+B/Ctrl+J 未绑定」的已知不一致 —— 已过时，现已绑定
- 文档原话（6.1）：帮助对话框额外列出 Ctrl+B 与 Ctrl+J，但全局绑定未包含这两项
- 证据：use-keyboard-shortcuts.ts:153-164 已绑定 ctrl+b,meta+b,ctrl+1,meta+1 与 ctrl+j,meta+j,ctrl+2,meta+2；帮助表（ShortcutHelpDialog.tsx:38-39）与绑定现一致

### A13. 消息导航轨阈值「≥4 条消息」 —— 实际为 ≥2 条用户消息
- 文档原话（4.4）：≥4 条消息时右侧点状导航（data-role 区分角色）
- 证据：ChatMessageList.tsx:279  userMessageIndices.length >= 2；圆点只代表用户消息（:94-97），MAX_NAV_DOTS=10 按比例映射（:47/:104-136）文档未提

### A14. 文件查看器形态失实 —— 非 Dialog，文件名也非 FileViewerDialog.tsx；「脏数据阻止关闭」仅部分
- 文档原话（4.7）：实现 [FileViewerDialog.tsx]；脏数据阻止关闭（确认后才可退出）
- 证据：实际文件 FileViewerPanel.tsx（组件同名），挂在右面板「文件」tab（DevPanel.tsx:226-238），非模态；脏确认仅编辑→只读切换有 confirm（FileViewerPanel.tsx:242-252），切换文件（file-viewer-store.ts:99-108 直接重置）与关闭 tab（DevPanel.tsx:130-136）均静默丢弃；i18n confirmCloseDirty（common.json:591）定义了但从未接线
- ✅ 部分修复：切换文件前脏数据确认已接线（file-viewer-store.openFile async + confirm，取消保持当前文件）；关闭 tab 静默丢弃仍保留（查看器状态在 store，tab 重开即恢复——内容并未真正丢失，见 DevPanel 条件渲染设计）

### A15. 斜杠命令「其余 toast 引导」 —— /help 开对话框、/interrupt 真停止、/goal 真预填
- 文档原话（4.3）：带 action 的命令点击直接执行（/new 回欢迎页、/clear 清空消息、其余 toast 引导）
- 证据：ChatPanel.tsx:440-469 —— /help 打开 ShortcutHelpDialog（:450-453）；/interrupt 真实 stop()（:459-462）；/goal 预填（:463-467）；仅 /models /compact 走 toast（:454-458）

### A16. 命令面板操作组 4 条 —— 实际 7 条；Ctrl+K 入口未记载
- 文档原话（4.9）：操作（新建会话/切换主题/打开设置/切换侧栏视图）
- 证据：CommandPalette.tsx:103-184 共 7 条（另有 toggle-sidebar :151 / toggle-right-panel :162 / open-terminal :173）；use-keyboard-shortcuts.ts:145 ctrl+k,meta+k 也打开面板（入口清单遗漏）

### A17. 会话排序「按更新时间倒序」 —— 实际置顶优先 + updatedAt 倒序
- 证据：main 侧 session-service.ts:261  orderBy(desc(pinned), desc(updatedAt))

### A18. 白名单「后续同工具自动放行」 —— 语义过宽（同工具+同入参哈希、5 分钟 TTL）
- 文档原话（4.5）：白名单（批准 + rememberDecision，后续同工具自动放行）
- 证据：permission-service.ts:648-655 按 工具+入参 hash key、5 分钟过期；approval-utils.ts:194 canRememberDecision（限定 3 类）是死代码（仅测试引用），白名单按钮对所有 pending 类型无条件渲染

### A19. 其他小失实
- 「每会话一个 PTY」（4.8）：主进程按 terminalId 建 PTY，同会话可多开终端（TerminalPanel.tsx 多 tab）
- 「输出不经 store 中转」（4.8）：xterm 直写为主（TerminalView.tsx:88-91），但 use-terminal-bridge.ts:59 仍并行写 store buffer 兜底
- sections 文件数「18 个」（4.10）：实测 20 个（含 usage/turns/rules-memory）
- SettingsDialog.tsx:92 注释「4 组」与实际 5 组不符（行为 5 组 15 项属实）；approvals-store.ts:11 注释「1s 自动出队」无实现（dismiss 无调用方）

## B. 【真实实现但文档未提及的能力】

1. 侧栏搜索即时过滤 + 300ms 防抖 2s 高亮（Sidebar.tsx:111-166）—— 文档反而声称「无过滤」
2. 文件夹右键菜单：打开资源管理器 / 删除文件夹（批量删会话带确认，Sidebar.tsx:428-456）；会话项更多菜单含「打开资源管理器」（thread-item.tsx:291-298）
3. 会话目标栏 GOAL：输入框上方 暂停/恢复·编辑·删除 + /goal 命令创建目标（ChatPanel.tsx:379-432, 471-483，goal:list/create/clear 真实 IPC）
4. Agent 提问对话框 AskDialog：ask_user_question 工具 UI（单选/多选+自由输入+分节进度条，agent:ask:respond 回传）（AppShell.tsx:356, ask-dialog.tsx）
5. @ 提及文件补全：输入 @ 触发 search.glob 防抖文件建议（ChatInput.tsx:231-270）—— 文档只提 @ 附件按钮
6. /interrupt、/goal 斜杠命令（ChatInput.tsx:71-72, ChatPanel.tsx:459-467）
7. Ctrl+K 等价打开命令面板（use-keyboard-shortcuts.ts:145）；Ctrl+B/J/` 面板切换 + 打开终端快捷键已真实绑定
8. FuzzySearchDialog（Ctrl+F 文件+会话统一搜索，键盘 ↑↓/Enter/Esc）
9. 审批拒绝后二次操作：编辑重提（run_command 提取命令回填 composer）+ 跳过（inline-approval-card.tsx:203-226）
10. 右面板 tab 动态增删：默认仅 info 常驻，其余经「+」下拉按需加入、可关闭（DevPanel.tsx:129-140, 184-210）
11. 终端自动创建：切到终端 tab 无终端时自动建（TerminalPanel.tsx:136-140）
12. 设置页隐藏 pane：用量（UsageSection：今日/30 天/累计 + 热力图 + byModel 占比，session:getUsageSummary）、回合记录（TurnsSection）、规则与记忆（memory:list/clear）—— 文档能力矩阵未列
13. 移动端分区内嵌真实 IM 渠道配置（im-channels-section：im:list/start/stop，主进程 7 适配器）
14. 「上次回合已中断」提示条 + 限流横幅（ChatPanel.tsx:307-320, 290）
15. 审批双机制：rememberDecision 5 分钟记忆 + 持久化命令白名单（userData/whitelist.json）
16. 连续 assistant 消息折叠头像/角色行（isContinuation，message-item.tsx:255-256）；浏览器设备预设仿真（browser-pane.tsx:23-29）
17. 设置写穿透 SQLite（settings:set 落库 + 启动 settings:getAll 快照 + legacy localStorage 迁移，settings-store.ts:145-154, main.tsx:43-45）
18. DevTools 检查器（devtools:open 三停靠模式）；命令面板文件命令直达查看器（CommandPalette.tsx:186-207）

## C. 【未完成交互缺口】代码 TODO/占位/半成品但文档未列

1. 欢迎页首条消息丢失（A1，最严重）—— sessionStorage 只写不读
2. 文件树删除/复制路径/节点重命名无 UI 触发（A2）—— 三个操作全不可达，仅后端就绪
3. scanlines 假开关（A8）；温度设置死存储（A6）；系统提示词保存不生效（A7）
4. vim 模式仅存储（editor-section.tsx:39-44，i18n 明示「先存储偏好」—— 文档已诚实标注）
5. /models /compact 仅 toast 引导（ChatPanel.tsx:456，注释「完整链路后续增强」—— 文档已标注）
6. MCP 错误 message 未渲染（mcp-section.tsx:26-33 仅状态徽章，主进程 error 字段丢失）
   ✅ 已修复：mcp-section 渲染 lastError（状态行下方 role=status 红字，error/stopped_with_error 时显示）
7. SectionErrorBoundary 缺 resetKeys（SettingsDialog.tsx:275，pane 抛错后切分区错误态可能残留）
   ✅ 已修复：resetKeys={[activeSection]}，切分区重置错误态
8. Ctrl+N 新建会话不导航（AppShell.tsx:178-180 仅 enterWelcomeMode，与 Sidebar handleNewChat 的 navigate(ROUTES.home) 不一致，URL 停留当前路由）
   ✅ 已修复：onNewSession 补 navigate(ROUTES.home)，与 Sidebar 一致
9. 大量过期注释：Topbar.tsx:9「命令面板按钮(功能预留)」、ui-store.ts:19/AppShell.tsx:139「Shift+/ 命令面板入口」、router.tsx:47-49「首页直接渲染 ChatPanel chatId=draft」、experimental-section.tsx:5「消费方已接入」
   ✅ 已修复：上述过期注释全部更新为当前实现（A8 接入后 experimental 注释亦为真）
10. 文件树刷新兜底只重拉根目录一层（FileTreePanel.tsx:78-90）；sft-*、ti-action-btn 类无 CSS 规则
    ✅ 已修复：刷新覆盖根目录 + 全部已展开目录（并行重拉）；sft-head/sft-back/sft-title 补 CSS；ti-action-btn 改为与更多菜单同款工具类样式

## D. 【总体判断】

**核心链路完成度估测**：侧栏会话管理 95% ｜ 欢迎页创建 80%（首条消息丢失 -15%）｜ ChatInput 95% ｜ 消息渲染 90% ｜ 审批 92% ｜ 会话内搜索 95% ｜ 文件树+查看器 70%（删除/重命名/复制缺口）｜ 右面板 78%（goal 迁移、file tab 语义失实）｜ 命令面板 90% ｜ 设置页 75%（3 个假能力）｜ **综合约 85%**。

**评价**：
1. 文档「实事求是」精神落实得不错——归档空态、占位 pane（🚧 规划中）、vim 仅存储、Git 纯只读、浏览器说明页等诚实标注均与代码一致，这是本仓库文档最值得保留的部分。
2. 但文档明显滞后于代码演进：侧栏搜索（仅 UI → 真实过滤+高亮）、Ctrl+B/J（未绑定 → 已绑定）、右面板（goal 迁走、查看器改面板）三处是「文档比代码旧」的典型；A3/A12 属于文档低估能力，其余多为高估。
3. 真正危险的是 4 处「文档说能做、实际不能做」的反向失实：欢迎页首条消息丢失（功能性 bug）、scanlines 假开关、温度死存储、系统提示词不生效——用户按文档预期操作会得到错误结果，比「漏写」危害更大。
4. 文件树是质量洼地：后端 IPC（file:create/createDir/delete/rename/watch）与 hooks 全部就绪，但 UI 只暴露根目录新建与展开，重命名/删除/复制停在死代码与悬空 i18n/CSS 层面，与侧栏（重命名/删除/置顶全链路）形成鲜明对比。
5. 建议：以本次审计为准重写 08-ux-guidelines.md 的 4.x/6.x/8 节；优先修复 A1（首条消息透传）、A2（文件树操作入口）、A6-A8（三处假能力：接入或移除开关）。

## E. 【修复日志】

P0（第一轮，已提交）:
- A1 首条消息透传：lib/pending-message.ts（消费即移除 + 单测 5 例）→ ChatPanel 挂载发送
- A2 文件树操作：node-menu.tsx（目录=新建文件/目录/复制路径/重命名/删除；文件=复制路径/重命名/删除），startRename/deleteEntry 死代码激活
- A6 温度全链路：schema(0-2) → handler → StartAgentOptions → buildGenerationOptions temperatureOverride（用户值 > 模型级默认；思考模型官方忽略）→ use-agent 读设置注入 transport；单测 main 2 例 + shared schema 2 例
- A7 系统提示词：use-agent 读 settings ai.systemPrompt（trim 空串回落内置默认），显式 options 优先
- A8 scanlines：AppShell 条件渲染 .scanlines-overlay（--text 令牌，pointer-events:none），开关真实生效
- 附带：i18n copyFailed 误译修复（"笔记本电脑"→"复制失败"）；check-comments 模板插值误报修复；settings-pref.test 测试边界豁免登记

P1（第二轮，已提交）:
- 主题三态统一：THEME_CYCLE/nextTheme 单一循环（dark→light→system），快捷键/Topbar/命令面板共用；账户菜单改三选一（亮色/暗色/跟随系统 + 勾选），system 获得 UI 入口
- Ctrl+S 真接线：file-viewer-store 保存处理器桥接（registerSaveHandler/requestSave 模块级非响应式），AppShell 全局快捷键转发，查看器本地 keydown 移除（尊重自定义快捷键设置）
- 脏数据保护：openFile 切换文件前 confirm（取消保持原文件），单测 6 例
- 版本号去硬编码：useAppInfo hook（app:getInfo 单一真源），Topbar/账户菜单不再硬编码 v0.1.0
- C6 MCP lastError 渲染 / C7 SettingsDialog resetKeys / C8 Ctrl+N 导航 / C9 过期注释 / C10 深层刷新 + sft/ti CSS

P2（第三轮，已提交）:
- 首屏 chunk 拆分：SettingsDialog/CommandPalette/FuzzySearchDialog/ShortcutHelpDialog/DevPanel 全部 React.lazy + Suspense（主 index 840KB，SettingsDialog 128KB、DevPanel 112KB、CommandPalette 76KB 独立；check:bundle 总 14.6MB 趋势 -2.1%）
- 消息渲染 E2E：journey-chat 发送按钮路径断言 user 气泡 + assistant mock 文案渲染（原豁免记录撤销）；beforeAll 预热 ChatPanel/ChatInput 消除冷编译 flake；重试复用同一文本
- 文件树节点菜单单测 5 例 + 命令面板冒烟 3 例（三态循环标题）
- 分隔线键盘调整（←/→ 16px 步进 + Home/End 极值，此前仅 ARIA 语义）
- A18 白名单按类型收敛（canRememberDecision 接线，仅 run_command/write_file/edit_file 显示）+ 已决回显 × 关闭按钮（dismiss 激活）
- 命令面板平台修饰键（macOS ⌘ / Windows Ctrl）；browser-pane 设备栏关闭 aria-label；DevPanel/mcp-section 硬编码「加载中」走 i18n
- 重写 08-ux-guidelines 4.1-4.10/6.1/8/附录：A3/A4/A5/A9/A10/A11/A12/A13/A15/A16/A17/A18/A19 全部对齐代码现状

P2 剩余（第四轮已全部完成）:
- ✅ 侧栏 tabs roving tabindex：WAI-ARIA tabs 模式（←/→/Home/End 焦点移动+自动激活）；ModelSelector 菜单 roving focus（↑/↓ 循环、Home/End、打开聚焦选中项）；DevPanel 用 Radix Tabs（自带箭头键语义，核查无需改）
- ✅ SettingsDialog 冒烟单测 2 例（5 组 15 tab 渲染 + tab 切换激活）
- ✅ i18n 冗余清零：checker 升级支持 t(labelKey) 常量间接引用解析（消除误报）→ 删除 44 个真实死 key（双语同步）→ check:i18n --strict 并入 check:static 永久卡关
- ✅ /models 真实链路：受控打开 composer 项目栏模型选择下拉（ModelSelector 增 open/onOpenChange 受控 props）
- ✅ /compact 真实链路：session:compact IPC（meta+definitions+handler+组合根注入窗口感知压缩器）→ compressByTokenBudget 裁剪 → replaceMessages 事务落库 → 渲染层 setMessages 同步 + toast 结果；handler 2 例单测
- ✅ vim 模式真实行为：lib/vim-mode 纯逻辑（h/j/k/l/w/b/0/$/x/dd/i/a/I/A/Esc，10 例单测）接入 ChatInput（normal/insert 双态 + NORMAL/INSERT 徽章 + 光标落点）；设置页描述如实标注不支持项（y/p/v/u/数字前缀）

P3（设计修复轮 · CDP 实测驱动）:
- ✅ 消息列对齐：.messages-inner 居中限宽容器此前 CSS 已定义但从未渲染（消息通栏全宽 vs 820px 输入框错位）→ ChatMessageList 真实渲染；用户气泡 flex-end + max-width:72%；回归单测 ChatMessageList.test.tsx 8 例锁定
- ✅ composer 项目栏：基础样式改 820px 居中（此前全宽）；只读工作目录 .cpb-select.static（禁点击态样式）
- ✅ 焦点环统一：:where(a,button,[role=treeitem],[role=tab],.thread-item,.welcome-pill,.nav-dot):focus-visible 2px accent 焦点环（此前 button 焦点环缺失/不统一）
- ✅ 欢迎页挂载同步 enterWelcomeMode（/new/返回/删除回首页后品牌区与快捷操作曾隐藏）
- ✅ API Key 保存后模型列表失效刷新（模型选择器不再停留「未配置模型」）
- ✅ 导航轨定位核实（CDP 实测）：calc((100% - 820px)/2 + 24px) 圆点落在消息列 24px 内边距槽内、不与用户气泡重叠（气泡右缘 966 vs 圆点 982-994）——非缺陷，保持
- ✅ 右面板 tab 栏标签挤压修复（CDP 实测 bug）：6 个视图全开时标签被均分挤压至 0 宽（仅剩图标，首个 tab 显示半字残片）→ 改横向滚动模式（对齐 TerminalTabs：shrink-0 自然宽度 + overflow-x-auto 隐藏滚动条），新增视图自动滚动到末尾；实测 6 tab 全标签完整（span 20-40px）且列表可滚动
- ✅ 快捷键帮助对话框读设置真源（此前硬编码默认键：实测用户改 searchFile 为 Ctrl+Shift+F 后帮助表仍显示 Ctrl+F，与实际绑定不符）→ 5 个可自定义键动态渲染 + formatKeys 空格排版；F1 实测帮助表显示 Ctrl + Shift + F
- ✅ AskDialog 进度条 accent 填充（此前 bg-primary 与注释「accent 填充」不符，对齐导航圆点/热力图等进度视觉）+ 补 10 例单测（此前零覆盖）
- ✅ 日志面板两处布局修复（CDP 实测）：工具栏 5 个级别 chip + 行数 + 统计/刷新在 284px 面板横向溢出 55px → flex-wrap 换行；日志行容器被 Radix ScrollArea 内层 display:table 撑宽到 391px、横向滚动条不可达（长行尾部永远看不到）→ 改普通 overflow-y-auto 容器，实测 pre 273px 且 scrollW>clientW 可横向滚动
- ✅ 斜杠建议面板宽度修复（CDP 实测）：left-0 right-0 w-full 拉伸到输入舱全宽 728px，短命令行面板过宽失衡 → 左对齐 + max-w-sm，实测 384px
- ✅ 设置全屏 Sheet 15 个分区逐一切换实测：内容区零横向溢出（1133px 列）；暗色主题全量扫描（body/composer/消息气泡/右面板/设置 Sheet）：令牌全部正确翻转，无裸色残留（此前 cpb-select 暗色下 rgb(26,33,48) 系 color 0.15s 过渡瞬间采样假象，稳态 inherit 正确）；窄窗 1000/860/720px 实测无横向溢出（侧栏 <860px 自动收起）
- ✅ 会话内联重命名输入框让行（CDP 实测）：重命名时 hover 操作按钮仍占 52px，输入框只剩 97px → 重命名中隐藏操作按钮（.ti-actions.hidden 高特异性规则，display:flex 覆盖问题），输入框 97→157px 满行宽，关闭后按钮恢复
- ✅ 流程实测：/goal 需求回车 → 目标栏出现在输入框上方（672px 居中、accent 边框、条件文本 truncate）；重命名菜单 → 内联输入自动聚焦；文件变更/文件/浏览器三个 pane 空态文案正常渲染；顶栏按钮簇（折叠/命令面板/设置/主题）几何无裁切
- ✅ file:list 契约修复（CDP 实测）：modifiedAt 用 stats.mtimeMs 浮点（NTFS 100ns 精度）直接返回，FileEntrySchema 要求 int → 任何非空目录列表必 INVALID_RESPONSE → 文件树静默显示「空目录」。Math.floor 取整 + 契约单测（entries 全字段 int）；实测修复后文件树正常列出文件
- ✅ 文件查看器重复打开同文件清空 bug（CDP 实测）：同一文件二次触发（双击/事件重放）会重置 originalContent，而同步 effect 依赖 [data] 不变化不重跑 → 内容已加载却永久卡「空文件」。openFile 幂等化（同文件且无脏数据只确保面板可见），补单测；实测二次点击内容保持。附带实测：查看态纯文本回退正常（shiki 离线下优雅降级），编辑态 textarea 282×489 与高亮层同字体/同 padding/同行高（Martian Mono 12px/lh1.6/pad 14px 16px）对齐
- ✅ 会话条目右键菜单 / 命令面板 / 设置分组几何 CDP 实测通过（160px 菜单 5 项 32px 行高、视口内；560px 居中面板、39px 行高选中态）

