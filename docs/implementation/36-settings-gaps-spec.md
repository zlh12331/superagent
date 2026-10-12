# 36 · 设置面缺口补全（审批等待通知 / 终端设置 / 快捷键冲突与重置 / 清空全部会话）

- **状态**：**已实施**（2026-09-30；9b0d191e → e2228749 共 10 提交，V 矩阵逐条核对见
  §3.2；门禁实录见 §3.3）
- **判级**：四个子功能均为「全链路」形态（存储/契约 + 主进程或纯渲染层消费 + UI），合入
  单 spec 管理（同一批设置面缺口、同一轮四问判级；拆四份会碎片化复盘）
- **来源**：2026-09-30 设置面盘点（对照 5 组 13 分区 + 16 个 SETTING_KEYS 现状）确定的
  四个真缺口

## 0 四个子功能判级与边界总览

| # | 子功能 | 判级依据 | 链路形态 |
|---|---|---|---|
| A | 审批等待通知 | 新持久化字段 + 跨进程副作用（通知发送） | shared 字段 + main 消费 + UI 开关 |
| B | 终端设置域 | 新持久化域 + 主进程消费（PTY spawn）+ UI | shared 常量/门禁 + main 解析 + 新分区 |
| C | 快捷键冲突检测 + 恢复默认 | 纯渲染层（L2 store 已有域，零新增持久化） | renderer 纯函数 + 组件 |
| D | 清空全部会话 | 新 IPC 通道 + 破坏性数据操作 + UI | shared 契约 + main 服务 + 数据区 danger |

---

## 1A 审批等待通知

### 1A.1 需求

- **谁/场景**：后台挂回合的用户（关窗最小化到托盘，30 号驻留语义）。回合中途弹出权限
  审批时用户在后台无感知，任务静默卡住直至审批超时（5 分钟）被拒。
- **语义边界**：`NotificationSettings` 加第三事件开关 `onApprovalRequested`（默认 true，
  fail-open 向 33 号「缺失即全开」语义兼容）。
- **不碰清单**：headless/IM 审批路径（结构性不通知，见 1A.2）；通知样式/点击聚焦行为；
  前台静默规则（`isAppInForeground`）；回合结束两开关既有语义。
- **不做清单**：按会话粒度通知、免打扰时段、通知声音开关。

**验收标准**：

- **V1** 缺失/损坏（无字段）→ 审批通知照发（fail-open）。
- **V2** 总开关关 → 审批通知不弹。
- **V3** 只关审批开关 → 审批不弹，回合结束通知照旧。
- **V4** 前台有焦点窗口 → 不弹（审批弹窗用户可见）。
- **V5** 设置重启保持（SQLite 真源 + 写穿透 + 启动快照）。
- **V6** resetAll 后回落默认开。
- **V7** 导入设置 → applyMainChange 按域合并不回写（33 号反例 4 防线覆盖）。
- **V8** `Notification.isSupported()=false` → 静默跳过。
- **V9** 总开关关 → UI 事件开关禁用（同 33 号 V9）。
- **V10** headless（webContents undefined）→ 不通知（lifecycle `onRequested` 仅在真实
  推送渲染层后触发，自动拒绝路径无通知——构造性保证，无代码分支）。

### 1A.2 设计

- **业务逻辑**：挂载点 = `PermissionService.onApprovalLifecycle` 的 `onRequested`
  （`requestApproval` 内**真实推送渲染层成功后**才触发——headless 自动拒绝 / webContents
  已销毁路径均不触发，V10 构造性成立）。新建 `mountApprovalNotifications(permissionService)`
  与 `mountTurnNotifications` 并列（`src/main/index.ts` 同处挂载），返回退订函数。
- **门控链**（与回合通知同序）：`shouldNotify`（enabled && onApprovalRequested，即时读
  `readNotificationSettings`）→ `isAppInForeground()` → `Notification.isSupported()`。
  读设置复用 33 号 `readNotificationSettings`（字段级收窄 + fail-open + warn 痕迹），
  仅扩一字段。
- **通知属性**：不传 `silent`（系统默认音）——与回合结束的 `silent: true` 有意区分：
  回合结束是告知（轻柔），审批等待是**需要用户行动**（不响应 5 分钟即超时拒绝，代价高）。
  body 含工具名；点击 → `showMainWindow()`（回应用去审批）。
- **契约/IPC**：零新增 IPC；notification 键已在 SETTING_KEYS（33 号），只扩值字段，
  无值级门禁（全布尔域，同 33 号既有取舍）。
- **状态管理**：settings-store `notification` 域加字段；`applyMainChange` 走「其余对象域
  按域合并」既有分支（V7 零代码）。
- **UX/UI**：notification-section 三个事件开关组加第三个 ToggleRow（disabled 跟随总
  开关，V9）；i18n `settings.notificationApprovalLabel/Desc` 双语。
- **反例点名与处置**：
  1. 在途写穿透竞态 → 接受秒级窗口（33 号同款取舍：最坏多/少弹一条）。
  2. 审批风暴（连续多工具审批）→ 每条审批一条通知，不做去重/合并（后台连跑本就是
     逐条等待，合并反而丢失信息；现实频率由白名单/记忆决策压制）。
  3. 超时后的回合出错通知叠加 → 有意叠加（审批通知在前，错误通知在后，时间线自洽）。
  4. 无桥（浏览器模式）→ mock 透传，通知行为本就不存在（33 号同款）。

### 1A.3 测试

- 主进程 `notification.test.ts` 扩展：mountApprovalNotifications 矩阵（V1/V2/V3/V4/V8
  + 通知 body 含工具名 + 默认音断言）。
- 组件 `notification-section.test.tsx` 扩展：第三开关 toggle 写穿透 + V9 disabled。
- store 测试：快照缺字段回落 + applyMainChange 合并不回写（V5/V7）。

---

## 1B 终端设置域

### 1B.1 需求

- **谁/场景**：Windows 用户（PowerShell/cmd/Git Bash/WSL 四选一是终端应用标配）+ 终端
  字号不适用户。现状：默认 shell 由主进程平台规则写死（win32 恒 powershell.exe），xterm
  字号硬编码 13。
- **语义边界**：新 SETTING_KEY `terminal`，值 `{ shell: TerminalShellChoice, fontSize: number }`。
- **不碰清单**：
  - `terminal:create` 的 **P0 收口不动**（渲染层仍永传 `command: undefined`，IPC 边界
    仍拒绝非空 command）——shell 选择由**主进程消费设置**解析，渲染层不传 shell，
    不重新打开「任意进程原语」；
  - Agent 工具侧 `terminal.tool`（显式 command 路径优先于默认 shell，不受影响）；
  - cwd 回退、env 过滤、resize/kill 行为。

**验收标准**：

- **V1** 缺失/损坏 → 行为与现状完全一致（win32 powershell.exe / unix $SHELL、字号 13）。
- **V2** 选 auto → 平台默认（即现状）。
- **V3** 选平台不适用档位（如 macOS 选 wsl）→ 回落平台默认（fail-open）+ warn 痕迹。
- **V4** gitbash 候选路径全不存在 → 回落平台默认 + warn 痕迹。
- **V5** 显式配置的 shell spawn 失败 → TERMINAL_SPAWN_FAILED 报错（不静默回退——用户
  显式配置的错误要可见，静默回退会造成「配置了但没用」的困惑）。
- **V6** 字号重启保持 + 导入值超界 → clampFontSize 归一到最近档（35 号 clampZoom 同构）。
- **V7** resetAll 后回落 auto/13。
- **V8** terminal:create 工具路径（显式 command）不受设置影响。
- **V9** 打开中的终端改字号 → xterm 实时更新（无需重开终端）。
- **V10** 值级门禁：shell 非法档位 / fontSize 非法档位 → settings:set 拒绝（写拒在前，
  读侧 clamp 兜底——双防线，35 号 §2.3 同构）。

### 1B.2 设计

- **shared 常量**（新 `packages/shared/src/constants/terminal-shell.ts`，对齐 constants/zoom.ts
  先例，main/renderer 双 barrel 导出）：
  - `TERMINAL_SHELL_CHOICES`：`['auto','powershell','cmd','gitbash','wsl','bash','zsh','fish']`
    + `TerminalShellChoice` 类型；
  - `terminalShellChoicesForPlatform(platform)`：win32 → auto/powershell/cmd/gitbash/wsl；
    darwin → auto/zsh/bash；linux → auto/bash/zsh/fish（UI 选项与主进程适用性共用）；
  - `TERMINAL_FONT_SIZES = [12,13,14,16,18]` + `DEFAULT_TERMINAL_FONT_SIZE = 13`（**13 是
    现状硬编码值，默认取 13 保证升级零视觉变化**）+ `clampFontSize`（非有限数 → 默认；
    其余归最近档，clampZoom 同构）。
- **shared 门禁**：`SettingsSetReqSchema` 加 terminal superRefine（value 非空对象 + shell ∈
  CHOICES + fontSize ∈ FONT_SIZES）；白名单契约测试同步（33 号教训：登记新键必须同步
  `settings-schema.test.ts` 的 toEqual 清单）。
- **main 消费**（terminal-service.ts）：
  - `resolveShellChoice(choice, platform, fileExists=existsSync)`（导出纯函数，fs 注入可测）：
    choice → {file,args}；平台不适用 / gitbash 候选路径全缺 / unix shell 不存在 →
    undefined（调用方回落平台默认）+ 由调用方 warn；gitbash 候选：`Program Files\Git\bin\bash.exe`、
    `Program Files (x86)\Git\bin\bash.exe`、`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`；
  - `defaultShell()` 改为 `resolveConfiguredShell() ?? 平台默认`——**即时读** readSetting
    （spawn 时刻，33 号同范式；try/catch fail-open → 平台默认）。解析点唯一：
    resolveShell command 空分支（工具显式 command 路径天然绕过，V8 构造性成立）。
  - **不做 spawn 失败自动回退**（V5 显式取舍）：fs 预检已挡主要场景，残余失败让用户看到
    TERMINAL_SPAWN_FAILED 并重试/改配置，静默回退违反「显式配置的错误要可见」。
- **renderer**：
  - settings-store：`TerminalSettings` 域 + `updateTerminal` + DEFAULT `{shell:'auto',fontSize:13}`；
    `applySettingsSnapshot` 读侧 clampFontSize 归一（35 号 V1 同构）；
  - `TerminalView`：fontSize 从 settings-store 读取；xterm 实例 ref 化，字号变化 →
    `term.options.fontSize` 实时更新 + fitAddon.fit()（V9）；创建时用当前值（现状 13）；
  - 设置页：新分区 `terminal-section.tsx`（SectionTitle + shell SegControl
    （`terminalShellChoicesForPlatform` 当前平台）+ fontSize SegControl）；导航挂
    capabilities 组（与 browser/workspace 同域），`SettingsSectionId` 扩 `'terminal'`；
  - 平台判断：renderer 各文件自持 `navigator.platform` 常量（IS_MAC 先例），分区文件
    内定义 `IS_WIN`/`IS_MAC`。
- **反例点名与处置**：
  1. 渲染层传 shell 上 IPC → 结构性不可能（terminal:create 契约无 shell 字段，P0 收口
     注释锚定）。
  2. DB 损坏值（shell:'hack'）→ 读侧收窄到 CHOICES（不在集合 → auto）+ superRefine 写拒。
  3. 字号在途写 → 终端在下一次创建/变更时读新值，接受（非数据损坏）。
  4. mock（浏览器模式）→ settings kv 透传（33 号实证），终端 mock 域不消费该键。

### 1B.3 测试

- shared：constants 纯函数测试（平台选项表 / clampFontSize 边界）+ 门禁测试（V10）。
- main：`resolveShellChoice` 平台矩阵（V2/V3/V4，fs 注入 fake）+ defaultShell 读设置
  （vi.mock settings-pref，33 号手法）+ V1/V8。
- renderer：TerminalSection 组件（选项表随平台、toggle 写穿透）+ store 快照合并。

---

## 1C 快捷键冲突检测 + 恢复默认

### 1C.1 需求

- **谁/场景**：自定义 6 个快捷键的用户。现状：录键不检测冲突（与其他自定义键或 12 组
  固定键重复 → 双触发/抢占无提示）；没有恢复默认入口（resetAll 是全量重置，粒度不可用）。
- **语义边界**：录键时检测 → 冲突则 toast 拒绝写入（保留旧值）；单键恢复默认 + 一键
  全部恢复。
- **不做清单**：冲突时「重新分配给谁」的二选一 UX（VS Code 式 overwrite 询问——6 个键
  的规模不值得）；快捷键录制交互改版（formatShortcut/IGNORED_KEYS 不动）。

**验收标准**：

- **V1** 录入与其他自定义键重复 → toast 指明冲突动作，store 不写。
- **V2** 录入与固定键重复（Ctrl+B / Ctrl+K / ? / F1 / Ctrl+` / Alt+← / 面板键 / 缩放键）
  → 同上。
- **V3** Meta/Ctrl 视为等价（跨平台归一）：mac 录 Meta+B 与固定 Ctrl+B 冲突。
- **V4** 空串（解绑）永不冲突。
- **V5** 与自身当前值相同 → 放行（no-op）。
- **V6** 单键恢复默认（仅与默认值不同时显示入口）。
- **V7** 一键全部恢复默认 → confirm 后写 DEFAULT_SHORTCUTS。
- **V8** 冲突清单与 use-keyboard-shortcuts 固定键绑定同源维护（同文件导出，漂移可见）。

### 1C.2 设计

- **归一化**（renderer 新 `lib/shortcut-conflicts.ts` 纯函数）：
  `normalizeShortcutForCompare(s)`：修饰符归一（Meta→Ctrl 等价，V3）+ 排序（alt<ctrl<shift）
  + 主键 lower；空串 → null。
- **固定键清单**：`use-keyboard-shortcuts.ts` 导出 `FIXED_SHORTCUT_CONFLICTS`
  （`{ match: 归一化串; labelKey: i18n }[]`，labelKey 复用 shortcutHelp.item.* 文案），
  与 useHotkeys 绑定串同文件相邻维护（V8）。缩放键的 shift 变体（ctrl+shift+=）与
  '+' 键形态（ctrl+shift++）一并列入。
- **冲突判定**：`findShortcutConflict(next, excludeKey, shortcuts)` →
  `{kind:'fixed'; labelKey}` | `{kind:'custom'; key}` | null；exclude 自身（V5）。
- **接线点**：ShortcutsSection 的 onChange（ShortcutPicker 保持纯录制控件，不知业务
  清单）；冲突 → `toast.error(t('settings.shortcutConflict', { action }))` + 不写 store。
- **恢复默认**：settings-store 导出 `DEFAULT_SHORTCUTS`（DEFAULT_SETTINGS 改引用它，
  单一真源）；单键行内 RotateCcw 小钮（value !== default 时显示，V6）；分区底部
  「恢复默认」outline 按钮 → confirm（danger: true，覆盖类）→ updateShortcuts(DEFAULT_SHORTCUTS)。
- **状态管理**：零新增域（shortcuts 域既有写穿透）。
- **反例点名与处置**：归一化只用于比较、不回写存储格式（存储格式 "Meta+P" 不变）；
  fixed 清单漂移 → 同文件导出 + 测试锚定（V8）；冲突检测在 Recording 中途 Esc/清空
  路径不触发（onChange 只在有效录值/显式清空时回调，空串直接放行 V4）。

### 1C.3 测试

- `shortcut-conflicts.test.ts`：归一化矩阵（V3/V4）+ 冲突矩阵（V1/V2/V4/V5，固定键
  逐组抽测 + 自定义互斥）。
- `shortcuts-section.test.tsx` 扩展：冲突 toast 不写 store（V1）、单键重置（V6）、
  全部重置 confirm 流（V7）。

---

## 1D 清空全部会话

### 1D.1 需求

- **谁/场景**：需要批量清理历史的用户。现状：逐会话删除是唯一路径（每条都要 hover +
  confirm），无一键清空；resetAll 只删设置键不碰会话数据。
- **语义边界**：新 IPC `session:clearAll` → 删除 sessions 全表（messages/turns/goals 经
  FK ON DELETE CASCADE 级联）→ 数据区 danger 按钮（confirm-dialog-store）。
- **不碰清单**：tasks/cron_tasks 表（**无 FK、有意**——cron 任务独立于会话存活）；
  会话导出/导入；单会话删除语义；启动备份轮转（db.ts 既有兜底不动）。
- **不做清单**：软删除/回收站（导出已是用户级备份手段）；按工作目录批量删除。

**验收标准**：

- **V1** 清空后 sessions/messages/turns/goals 表空，响应含真实删除计数。
- **V2** 有运行中回合 → 拒绝（新错误码 `SESSION_IN_USE`），不删任何数据（先停后删）。
- **V3** 级联完整性：消息/回合/目标一并删除（FK cascade 构造性 + 测试断言）。
- **V4** 渲染层成功后：会话列表/详情/回合/最近目录缓存清空重拉，激活会话复位回首页。
- **V5** 危险确认：danger 样式 confirm，文案说明不可恢复。
- **V6** 运行中回合被拒 → toast 展示「先停止回合」（错误码 i18n）。
- **V7** 失效广播：sessions/usage/turns/goal 四域声明（用量/最近回合/目标均被级联清空）。
- **V8** 幂等：空表清空 → deleted=0，不报错。

### 1D.2 设计

- **shared**：`SessionClearAllReqSchema = z.object({})` + `SessionClearAllRes { deleted: number }`
  （schema/interface 双登记，对齐 SessionDeleteRes 形态）；meta `clearAll: request('session:clearAll')`
  + definitions withSchema（定义表红利：preload API/类型/注册自动生成）。
- **错误码**：`ErrorCode.SESSION_IN_USE`（constants/errors.ts）+ ERROR_META 全覆盖
  （既有单测锚定）+ errors.json 双语。
- **main 服务**：`SessionService.clearAll()`——`db.delete(sessions).run()`（drizzle 无
  where 全表删除，RunResult.changes 即删除数）→ `reclaimFreePages()`（对齐单删）→
  `broadcastInvalidation([sessions, usage, turns, goal])`（31 号声明式失效；不含
  session:<id>——渲染层 mutation removeQueries 前缀清理，同单删 S1 取舍）。
- **main handler**：deps 注入 `hasRunningAgentTurns: () => boolean`（组合根传
  `serviceContainer.hasRunningAgentTurns()`——关窗协商同一真源，不引新依赖）；running →
  `AppError(SESSION_IN_USE)`。守卫放 handler（服务层保持纯数据操作，与 compactMessages
  注入同模式）。
- **renderer**：
  - `lib/settings-ops.ts` 加 `clearAllSessions()`（unwrap 模式同 exportAllSessions）；
  - `use-sessions.ts` 加 `useClearAllSessions`：onSuccess → `removeQueries({queryKey:['session']})`
    （详情/回合/最近目录前缀清——含 recent-dirs 属有意，重拉即可）+ toast 由调用方出；
    onSettled → invalidate `['sessions']`；
  - DataSection：新 danger 行「清空全部会话」→ confirm（danger）→ mutateAsync →
    成功：`clearActiveSession()` + `navigate(ROUTES.home)` + `closeSettings()`（对齐
    Sidebar 删除激活会话的回落行为）+ toast 计数；失败：`unwrapErrorMessage`。
- **mock-api**：session 域加 clearAll（清 mockSessions/messagesBySession，返回计数）。
- **反例点名与处置**：
  1. 清空瞬间回合 appendMessage → V2 守卫拒绝整个操作（不做部分删除）。
  2. ChatService 流（ask 模式）在跑 → hasRunningAgentTurns 只看 agentService——与关窗
     协商同真源（项目权威「运行中」定义）；ask 流写入的会话被清属可接受（消息级联后
     appendMessage 幂等失败不崩）。
  3. cron 触发的回合在跑 → 同样被 hasRunningAgentTurns 拦住（cron 回合走 agentService）。
  4. 导入含大量会话后清空 → 全表 DELETE 单语句，无逐行开销。
  5. 浏览器模式（无桥）→ settings-ops hasIpcBridge 守卫静默（同 exportAllSessions）。

### 1D.3 测试

- service：clearAll 计数/级联（V1/V3）/空表幂等（V8）/失效域声明（V7）。
- handler：running → SESSION_IN_USE（V2/V6）。
- 组件 data-section：confirm 流 + 成功后清理（V4/V5）+ 失败 toast（V6）。

---

## 2 提交链（每提交独立可编译可回退）

1. `9b0d191e` `docs(design)` 本 spec 初稿（需求 + 设计节）；
2. `7ce8e0e7` `feat(main)` 36-A 审批等待通知：域字段 + readNotificationSettings 扩展 +
   mountApprovalNotifications + index 挂载 + 主进程测试；
3. `c8637101` `feat(ui)` 36-A 设置行 + i18n 双语 + 组件/store 测试；
4. `d1d4e10c` `feat(shared)` 36-B 终端设置地基：terminal-shell 常量 + SETTING_KEYS 登记 +
   门禁 + 契约测试同步；
5. `2e27cd94` `feat(main)` 36-B 默认 shell 接管：resolveShellChoice + defaultShell 即时读 +
   测试；
6. `f6f82063` `feat(ui)` 36-B 终端分区 + TerminalView 字号接线 + i18n + 测试；
7. `4751cb2b` `feat(ui)` 36-C 快捷键冲突检测 + 恢复默认（合并为一提交：二者在
   ShortcutsSection 重写中交织，强行拆分需人为割裂同一组件——偏离 §2 计划的两提交，
   如实披露）；
8. `75cf9d76` `feat(ipc)` 36-D session:clearAll：错误码 + schema/meta/definitions + 服务/
   handler + 测试；
9. `304f2f68` `feat(ui)` 36-D 数据区清空入口 + 缓存清理 + i18n + 测试；
10. `e2228749` `fix(ui)` 验证期审计修复（棘轮放宽登记 + 一致性重构，见 §3.3）。

## 3 状态

### 3.1 实施期实测修正（设计节与实现的差异，如实披露）

1. **36-B 字号热更形态**：设计时按「term ref 化 + 二段 effect」实现首轮通过，但
   check:ui-consistency 的 render-ref-write 棘轮拒绝 4 处新增 ref 写入。终版改用
   **zustand subscribe**：主 effect 内订阅 store，闭包直接持有 term/fitAddon
   （生命周期与实例严格一致，dispose 即退订），零 ref、零重建。比设计稿更优。
2. **36-C 固定键清单的 '+' 键缺口**：'ctrl+shift++'（e.key '+' 的 shift 变体）无法被
   '+' 分隔的存储格式往返（normalize 得 null），录入侧本就产生损坏串——清单**不收**
   该变体，由 store 格式约束排除（锚定测试固定 13 条）。
3. **check-i18n 间接引用规则**：`t(SHELL_LABEL_KEYS[choice] ?? '...')` 表达式实参会
   逃过「key 形状字面量 + 间接 t()」扫描（误报冗余）——改为先取 `const labelKey`
   再 `t(labelKey)`（对齐脚本注释的既有约定）。
4. **36-D 双弹陷阱**：mutateAsync 的 catch 与 mutation onError 各弹一次 toast——按
   AGENTS.md「调用层不重复挂 onError」约定，组件侧 catch 仅吞 rejection。
5. **测试基建**：DataSection 引入 useNavigate/useClearAllSessions 后，general-section
   / SettingsDialog / data-section 测试需补 Router + QueryClient 上下文；SettingsDialog
   导航 tab 断言 13→14（新增终端分区）。

### 3.2 验收核对

**36-A（V1-V10）**：主进程 notification.test.ts 七断言（V1 fail-open / V2 总开关 /
V3 单开关+即时读 / V4 前台 / V8 isSupported / 部分损坏字段收窄 / onResolved 零通知）；
V10 headless 为构造性保证（onRequested 仅在真实推送后触发，requestApproval 代码路径）；
V5/V6/V7 store 快照回落 + applyMainChange 合并不回写断言；V9 组件 disabled 断言。
**全过**。

**36-B（V1-V10）**：shared 常量测试（平台选项表 / clampFontSize 非有限数前置拦截）+
门禁测试（V10）；resolveShellChoice 平台矩阵（V2/V3/V4，fs 注入）+ defaultShell 读设置
（V1 损坏 fail-open / V8 显式 command 不受影响 / 平台不适用 warn）；V5 不做 spawn
失败静默回退（设计取舍，注释锚定）；V6/V7 store 快照 clamp + resetAll 白名单自动覆盖；
V9 subscribe 热更（TerminalView 实测 mock options 更新）。**全过**。

**36-C（V1-V8）**：归一化矩阵（V3 Meta≡Ctrl / V4 空串）+ 冲突矩阵（V1 自定义互斥 /
V2 固定键含缩放组 / V5 exclude 自身）+ 清单锚定（V8：13 条 + labelKey 形状 + normalize
可复现）；组件测试（V1/V2 toast 拒绝不写 store / V6 单键重置 / V7 confirm 放行与拒绝）。
**全过**。

**36-D（V1-V8）**：service 测试（V1 计数 / V3 级联 SESSION_NOT_FOUND / V7 四域广播 /
V8 空表幂等）；handler 测试（V2/V6 SESSION_IN_USE 拒绝且服务不调用）；组件测试
（V4/V5 confirm 放行 + IPC 入参 / 拒绝不发起 / 异常 toast 单发）。**全过**。

### 3.3 门禁实录

- typecheck / lint / check:static 15 项全过；knip（files/deps/binaries）零问题；
- 全量测试链：shared 105 + main 2117 + renderer 1830 + integration 152 + scripts 364
  = **4568 全绿**；
- **棘轮放宽登记 3 处**（33-35 号先例同款，`--update-baseline` 显式放宽）：
  ① `check-file-size.baseline.json` definitions.ts 1046→1055、mock-api.ts 983→991
  （新增 clearAll 定义块 / mock）；② `check-functions.baseline.json` mock-api max
  382→388（同因）；agent-service.ts 704 为存量超限（未触碰，不在本轮范围）；
- 复盘双锚：用户反馈 + 诊断包日志（shell 回落 warn / 通知发送失败 warn / 清空操作
  logger.info 均随诊断包导出）；四功能均为纯设置门控/数据操作，不进 experimental。
