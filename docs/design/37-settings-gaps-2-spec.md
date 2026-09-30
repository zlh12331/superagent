# 37 · 设置面补全二期（编辑器域补全 / 备份可见性）

- **状态**：实施中
- **判级**：37-A 全链路（新持久化字段 + 跨层消费：store→CSS 变量/组件双路径）；37-B
  全链路（新 IPC 域 + 文件系统操作 + 危险恢复语义）。合入单 spec（同一批设置面缺口）
- **来源**：2026-09-30 设置面盘点遗留的两项（36 号完成后的次优先项）

## 1A 编辑器域补全（自动换行 + Tab 宽度）

### 1A.1 需求

- **谁/场景**：查看/编辑长行代码的用户。现状：FileViewerPanel 的 textarea `wrap="off"`
  硬编码（长行只能横向滚动）；tab 字符按浏览器默认 tab-size 8 渲染（查看/编辑/聊天代码
  块口径一致但不可调）。
- **编辑面形态结论（判级依据）**：本应用的编辑面是 **FileViewerPanel 的 textarea +
  shiki 高亮叠加层**（非 CodeMirror 类编辑器），fontSize 的真实消费方是聊天消息区
  （ChatPanel），vimMode 已在 ChatInput 真实生效。据此：
  - **wordWrap 值得补**——长行查看/编辑是高频场景，textarea 形态下成本低；
  - **tabSize 值得补**——CSS `tab-size` 天然覆盖全部代码面（查看/编辑/聊天代码块/
    diff），一个变量统一口径；
  - **不做**：换 CodeMirror（形态级重构，超出设置面范畴）、行号、字体族。
- **语义边界**：`EditorSettings` 加 `wordWrap: boolean`（默认 false=现状）+
  `tabSize: 2|4|8`（默认 8=浏览器默认=现状）。

**验收标准**：

- **V1** 缺失/损坏（无字段）→ 行为与现状完全一致（不换行 / tab-size 8）。
- **V2** 开启自动换行 → 编辑态 textarea `wrap="soft"`，高亮叠加层与查看态
  shiki/plaintext 同步 `pre-wrap`（长行折行不破版式）。
- **V3** 编辑态对齐：wrap 开启时 textarea 与高亮层的换行算法**逐行一致**
  （两层同 `white-space: pre-wrap` + `word-break: break-all`，同字体/宽度/内边距）。
- **V4** tabSize 档位生效于全部代码面：文件查看器（查看+编辑叠加层）、聊天代码块、
  diff 行——经 CSS 变量 `--code-tab-size` 单点收敛。
- **V5** tabSize 重启保持；损坏值（非档位）读侧 clampFont 归一（36 号 B 同构双防线）。
- **V6** 恢复默认设置（resetAll）→ 回落不换行 / 8。
- **V7** 值级门禁：tabSize 非档位 / wordWrap 非布尔 → settings:set 拒绝（写拒在前，
  读侧 clamp 兜底）。
- **V8** 导入设置 → applyMainChange 按域合并即时生效。

### 1A.2 设计

- **shared**（新 `constants/editor.ts`，对齐 terminal-shell 先例）：`EDITOR_TAB_SIZES
  = [2,4,8]` + `DEFAULT_EDITOR_TAB_SIZE = 8` + `clampEditorTabSize`（非有限数前置拦截，
  35/36 号同构）+ `isEditorTabSize`。`SettingsSetReqSchema` 加 editor superRefine
  （value 非空对象；wordWrap/tabSize 字段存在时才校验——部分写入合并语义）。
- **状态管理**：settings-store editor 域加字段（DEFAULT 同步）；快照读侧
  `clampEditorTabSize` + wordWrap 布尔收窄；applyMainChange 走既有按域合并分支（V8
  零代码）。
- **wordWrap 消费**（FileViewerPanel 单组件直读 store）：
  - 编辑态：textarea `wrap={wordWrap ? 'soft' : 'off'}`；容器 `.file-viewer-editor`
    加 `wrap-on` 类；
  - 查看态：`.file-viewer-body` 加 `wrap-on` 类；
  - CSS（file-tree.css）：`wrap-on` 下 textarea/高亮层/`pre.shiki`/plaintext 切
    `white-space: pre-wrap` + `word-break: break-all`——**break-all 双层对称**是
    对齐保证（V3）：textarea 与高亮层同字体/同宽/同内边距 + 同确定换行算法 ⇒ 逐行
    对齐不破。shiki pre 的内联 style 已有 `!important` 覆盖先例（background），white-space
    经类选择器覆盖（shiki 输出无内联 white-space，实测口径以实现为准）。
- **tabSize 消费**（CSS 变量单点）：
  - `base.css` 定义 `:root { --code-tab-size: 8; }`（行为变量，非设计令牌——**不放
    tokens.css**，避开 tokens:check 生成物一致性约束）；
  - 新 `hooks/use-editor-code-style.ts`（对齐 use-zoom-effect 单点范式）：订阅
    `editor.tabSize` → `documentElement.style.setProperty('--code-tab-size', n)`；
    AppShell 挂载（useZoomEffect 旁）。首帧无闪烁问题：默认 8=现状，非默认值在首帧
    后一帧内收敛（不采 theme 级首帧镜像——tab 宽度闪变无感知代价）。
  - 消费选择器（tab-size 可继承，按面定义一次）：`.file-viewer-body`、
    `.file-viewer-editor`（覆盖查看+编辑全部层）、`.msg-content`（聊天 Markdown）、
    `.diff-code`。
- **反例点名与处置**：
  1. wrap 开启后编辑对齐破裂 → V3 break-all 双层对称（确定算法，不做分词猜测）。
  2. shiki 未就绪（html=null）时编辑 → textarea 单层，无对齐问题。
  3. 旧库值缺字段 → DEFAULT 合并（V1）。
  4. mock（浏览器模式）→ settings kv 透传。
  5. --code-tab-size 未定义引用 → check:css-vars 门禁由 base.css :root 定义兜住。

### 1A.3 测试

- shared：常量测试（档位/clamp 边界）+ editor 门禁测试（V7）。
- store：快照缺字段回落 + 损坏 tabSize clamp（V1/V5）+ 写穿透（editor 键）。
- 组件：editor-section 两行新控件（V7 UI 半 + 写穿透）；FileViewerPanel wrap 切换
  （textarea wrap attr + 容器类名，V2）。

---

## 1B 备份可见性

### 1B.1 需求

- **谁/场景**：关心数据安全的用户。现状：启动热备份轮转（backups/ 最近 3 份）+ 损坏
  自愈**全部黑盒**——用户不知道有哪些恢复点、无法手动备份、无法从备份恢复。
- **语义边界**：新 IPC 域 `backup` 三方法——
  - `backup:list`：列出恢复点（名称/时间/大小/**quick_check 健康度**——「假恢复点比
    没有备份更危险」，健康度是列表与真实恢复点的分界）；
  - `backup:create`：手动立即备份（复用启动备份同一路径，**进同一轮转环**——语义
    简单：轮转环就是全部恢复点；在途启动备份经 pendingBackup 链序列化）；
  - `backup:restore`：从指定恢复点恢复（**暂存 + 重启生效**，见 1B.2）。
- **不碰清单**：BACKUP_KEEP=3 轮转策略、损坏自愈流程、keychain.dat、单删备份
  （轮转自动管理，不做 UI 删除）。

**验收标准**：

- **V1** 列表展示名称/时间/大小/健康徽标，最新在前；目录不存在/为空 → 空态文案。
- **V2** 立即备份：落盘成功后列表即时出现新条目（失效重拉），超 3 份最旧被轮转删除。
- **V3** 恢复确认（danger）+ 有运行中回合 → SESSION_IN_USE 拒绝（文案泛化为
  「先停止后再操作」，与 clearAll 共用）。
- **V4** 恢复 = 暂存 `sessions.db.restore-pending`（staging 前对该备份 quick_check
  校验）→ `app.relaunch()` + `app.quit()`（走 before-quit 善后链，closeDb 等待在途
  备份落地）→ **下次启动 initDb 顶部 applyPendingReplace 生效**（连接打开前替换，
  无句柄冲突）。
- **V5** 恢复目标损坏/损坏备份被换入 → 既有自愈链兜底（restoreCorruptDatabase →
  tryRestoreFromBackup），恢复流程不引入新故障态。
- **V6** 路径安全：restore 入参仅接受**裸文件名**（basename 校验 + 必须落在 backups/
  目录内），拒绝路径穿越。
- **V7** 暂存文件在启动时被消费后消失（rename 语义）；连续多次恢复确认 → 后者覆盖
  前者（最后一次确认的为准）。
- **V8** mock（浏览器模式）→ 三方法 mock 化（create 返回假条目、restore ok）。

### 1B.2 设计

- **为何「暂存 + 重启生效」而非热恢复**：WAL 连接持有文件句柄，覆盖打开中的库 =
  破坏性竞争；关连接→换文件→重开会让全部持有 `getDb()` 引用的服务失效（运行中回合
  必炸）。暂存方案把文件替换放在**连接打开之前**（initDb 顶部），复用既有自愈链
  （V5），与「更新安装=重启」的桌面成熟语义一致。代价：恢复需重启——confirm 文案
  明示。
- **重构**：db.ts 的 `backupDatabase`（原子落盘 + 权限 + 轮转，~55 行）抽到新
  `backup-store.ts`——备份文件操作（创建/列表/暂存/启动应用）单点归属；db.ts 净行
  **下降**（file-size 棘轮顺势收紧），保留 `pendingBackup` 调度与
  `createManualBackup()` 导出（序列化在途备份后调 createBackupFile）。
- **backup-store.ts 职责**：`createBackupFile(sqlite, dbPath)`（原 backupDatabase）、
  `listBackups(dbPath)`（readdir + stat + quick_check 健康，最新在前）、
  `stageRestore(dbPath, name)`（basename 校验 + quick_check + copyFileSync 暂存）、
  `applyPendingRestore(dbPath)`（initDb 顶部：暂存存在 → rm db+wal+shm → rename）。
- **IPC 契约**（meta/definitions 定义表驱动，preload/类型/注册自动生成）：
  `BackupListRes { backups: [{ name, createdAtMs, sizeBytes, healthy }] }`、
  `BackupCreateRes { name }`、`BackupRestoreReq { name } → { ok: true }`；
  handler `backup.handler.ts` deps 注入 `hasRunningAgentTurns`（36-D 同款），restore
  守卫通过后 stage + `app.relaunch()` + `app.quit()`（复用 app:quit 的善后链语义）。
- **渲染层**：`settings-ops.ts` 加 listBackups/createBackup/restoreBackup；
  新 `hooks/use-backups.ts`（BACKUPS_QUERY_KEY + useQuery + create/restore mutation
  ——查询逻辑放 hooks 域文件并导出 key 常量，项目约定）；DataSection 新「启动备份」
  子块（标题行 + 立即备份按钮 + 条目列表：时间/大小/健康徽标/逐行恢复 danger 钮 +
  confirm 明示「重启后生效、未导出改动丢失」）。
- **反例点名与处置**：
  1. 恢复期间新回合启动 → 守卫在 handler（V3），confirm 后到 quit 前的秒级窗口
     接受（回合会被善后链正常中断，与手动退出同语义）。
  2. 暂存后用户取消退出（关窗协商弹窗）→ 暂存保留，下次启动生效（V7 语义自洽，
     confirm 文案已说明「重启后生效」）。
  3. backups/ 目录不存在 → list 返回空数组（目录不存在与空列表同语义）。
  4. quick_check 大库耗时 → BACKUP_KEEP=3 有界（≤3 次全库扫描，设置页异步查询可
     接受；实测 82MB 级 VACUUM 35ms，quick_check 同量级）。
  5. SESSION_IN_USE 文案特化「清空」→ 泛化「操作」，两域共用单一真源。

### 1B.3 测试

- backup-store：list（排序/健康/空目录）、create（轮转删除最旧）、stage（路径穿越
  拒绝/健康校验失败拒绝/暂存落盘）、applyPending（暂存消费 + 无暂存 no-op）。
- handler：restore 守卫（SESSION_IN_USE）/ list/create 转发。
- 组件：DataSection 备份子块（列表渲染/立即备份失效重拉/恢复 confirm 流）。

---

## 2 提交链（每提交独立可编译可回退）

1. `docs(design)` 本 spec 初稿；
2. `feat(shared)` 37-A 地基：editor 域值扩展（wordWrap/tabSize）+ 值级门禁 +
   constants/editor + 契约测试；
3. `feat(ui)` 37-A 设置行 + --code-tab-size 单点 effect + 查看器自动换行 + i18n +
   测试；
4. `feat(ipc)` 37-B backup 域三通道：backup-store 抽离 + list/create/restore +
   暂存恢复链 + 测试；
5. `feat(ui)` 37-B 备份可见性：use-backups + 数据区子块 + i18n + 测试；
6. `docs(design)` 状态节收尾（V 矩阵核对）。

## 3 状态

（实施期回填）
