# 27 · 自动更新规格（最终方案）

- **状态**：设计定稿（第 10 节拍板项已确认），待实施（本文档描述目标形态，代码尚未落地）
- **基线**：electron-updater 6.8.9 / electron-builder 26.15.3
- **范围**：主进程更新服务、设置持久化、渲染层更新界面、发布门禁
- **不含**：云端更新服务（自建更新服务器、灰度放量、更新失败率统计）

## 1. 定位与原则

一句话定位：**发现全自动（每次启动即查）、安装永远由用户的退出或重启动作承载、全过程可见可取消、失败静默但可归因。**

六条原则：

1. 自动检查零打扰——失败（离线最常见）绝不弹错，只有手动检查才报错。
2. 发现即后台下载，安装不打断工作——沿用 `autoDownload` 与 `autoInstallOnAppQuit` 默认行为。
3. 开关语义单一可解释——用户能一句话预判关掉后发生什么。
4. 失败可归因——更新全链路日志必须进 `main.log` 与诊断包。
5. 升级路径可信——发布者校验 + 差分产物完整性门禁。
6. 用户有否决权——可跳过某版本、可稍后再说。

## 2. 基线事实

### 2.1 现状盘点

| 项 | 现状 |
|---|---|
| 更新服务 | `src/main/infra/update/update-service.ts` 薄封装：注册事件 → 推送渲染层；`check(manual)`；`quitAndInstall()`；dev 模式明确报错 |
| 自动检查 | **不存在**。`src/main/index.ts` 只调 `start()` 注册监听，全仓唯一触发点是 `src/renderer/hooks/use-update.ts` 的 `manual: true`（关于页手动按钮） |
| 进度数据 | 库按每秒一次节流推送 `{ total, delta, transferred, percent, bytesPerSecond }`，但 `AutoUpdaterLike` 只声明 `percent`，payload 只留 `progress`，且**无任何 UI 消费** |
| 状态持久性 | 事件通道只在事件发生时推送，无快照回放；窗口 reload / 渲染进程重建后状态归零 |
| 运行配置 | `autoUpdater` 未接管 logger（默认走主进程 `console`）、不设 channel；`autoInstallOnAppQuit` 用默认 true（无自动检查意味着无更新可装，实际不生效） |
| 契约 | `update:check` / `update:install` / `update:event:status` 定义表驱动 + zod 校验；`UpdateCheckRes` 声明了 `'up-to-date'` / `'available'` 但实现只会返回 `'checking'` / `'error'` |

### 2.2 差分能力（已具备，无需重建）

| 平台 | 机制 | 生效前提 |
|---|---|---|
| Windows (NSIS) | 安装器把自身复制为 `%LOCALAPPDATA%\<updaterCacheDirName>\installer.exe`（安装脚本 `templates/nsis/include/installer.nsh` + `NsisTarget` 的 defines），更新时以它为旧文件做块级比对 | 构建未关闭 `differentialPackage`（默认开）；发布 `*.exe.blockmap` |
| macOS | 以 `~/Library/Caches/<updaterCacheDirName>/update.zip` 为旧文件 | 至少经历过一次应用内更新下载；发布 `*.zip.blockmap` |
| Linux AppImage | blockmap 内嵌在 AppImage 尾部，`latest-linux.yml` 的 `blockMapSize` 供读取 | 以 AppImage 形式运行（`APPIMAGE` 环境变量存在） |
| Linux deb | 无差分 | — |

两个必须保留的性质：

- 旧 blockmap 的 URL 由「新版本号在下载路径中替换为旧版本号」推导，依赖版本号出现在 release tag 段；制品名不带版本号反而让 blockmap 内的文件名跨版本一致。
- 差分下载进度中的 `total` 是**差分包字节数**（只累加需下载的块），可直接显示为"增量更新，仅需下载 xx MB"。

### 2.3 已有资产（复用，不重建）

- 定义表驱动的 IPC 契约体系与 dev 侧 zod 校验
- `AutoUpdaterLike` 注入接口 + fake 实现（更新服务可单测，不 mock 模块）
- 设置持久化链路：`app_settings` 表 + `SETTING_KEYS` 白名单 + 启动快照（`settings-bootstrap`）
- 设置行组件：`settings-controls` 的 `SectionTitle` / `SettingRow` / `ToggleRow` / `SegControl`
- 发布链：三平台构建成功才打 tag；publish job 校验 `latest*.yml` 与三平台安装包齐全
- Release body 已是我们润色过的 CHANGELOG 段落（可直接作为更新说明）

## 3. 触发模型

| 触发源 | 时机 | 失败处理 |
|---|---|---|
| **启动检查（主触发）** | 窗口就绪后延迟约 5s，每次启动一次 | 静默退避重试 1min / 5min / 15min，3 次后本会话放弃，只记日志 |
| 手动检查（关于页按钮） | 不限 | 必须明确报错，且不受开关与退避限制 |
| 长会话兜底 | 窗口连续开着超过 12h 再查一次 | 静默 |

配套规则：

- 会话内检查去重：进行中的检查请求合并为一次。
- 开关由关切换到开：立即补检一次（复用 `update:check`，不新增 IPC 方法）。
- 延迟 5s 只为避开启动期资源争抢，不影响「打开就能看到更新」的感知。

## 4. 用户设置

- 新增 `update` 设置域，字段 `autoCheck: boolean`，**默认开**。
- 落点：`SETTING_KEYS` 增加 `'update'`；渲染层 settings-store 增加分组与 `setUpdate`（照 `experimental` 分组写法，写穿透经 `settings:set`）。
- 主进程在启动时用 `readSetting('update')` **同步**读取——启动检查不能等渲染层；值缺失或损坏时自动走默认 true。
- **语义：开关只管自动发现与自动处置。** 开 = 启动检查 + 后台自动下载 + 退出自动安装；关 = 以上全停，但用户手动检查后的下载与安装照常。
- 关闭时必须同时把 `autoUpdater.autoInstallOnAppQuit` 置 false，否则上一会话残留的已下载包仍会在退出时被安装。

## 5. 数据契约与状态

### 5.1 进度与状态的 payload 扩展

`UpdateStatusPayload` 增加可选字段 `transferred` / `total` / `bytesPerSecond`（zod 同步，保持向后兼容）。服务层不再对 `percent` 做取整截断，直接透传库给的全部字段。

### 5.2 注入接口扩展

`AutoUpdaterLike` 需要：

- `download-progress` 监听签名放开为完整进度对象
- `cancellationToken`（取消下载用；库中为公开只读属性）
- `update-cancelled` 事件订阅（取消后 UI 才能回到空闲态）

### 5.3 状态快照

主进程保存最近一次状态快照（`UpdateService.getStatus`），渲染层挂载时经 `update:getStatus` 读取并回填。否则窗口 reload 或渲染进程重建后，进度条会消失、"已就绪"会退回"检查更新"。

用请求-响应读快照（而非在订阅时经事件通道回放）：快照是"读状态"语义，天然不触发 toast，无需给事件加"回放"标记，也不会让"同阶段不弹"的去重记忆因组件重建而失效。实现上 `useUpdate` 以 `fromSnapshot` 区分来源，仅由实时事件驱动提示。

回放必须与新事件区分（例如标记 `replayed`）：否则 `UpdateNotice` 的"同阶段不重复弹"记忆会随组件重建归零，导致重载后重复弹已弹过的 toast。

### 5.4 契约修正

`UpdateCheckRes` 的枚举收敛到实现真正会返回的集合（`checking` / `error`）——结果状态经事件通道下发，IPC 响应只表示"检查已开始"。不采用"让 `check` 等到首个事件再返回"的方案：那会引入超时与竞态。

## 6. UI/UX 规格

### 6.1 四个接触点

| 接触点 | 位置 | 职责 |
|---|---|---|
| 关于面板 | 设置 → 关于（现 `UpdateBlock`） | 唯一完整信息面：状态、进度、更新说明、开关、操作按钮 |
| 顶栏常驻指示 | Topbar 右侧按钮簇 | 静默可见性：下载中 / 就绪时可见但不打扰 |
| Toast | `UpdateNotice` | 瞬时通知：发现新版、就绪、手动检查失败 |
| 确认对话框 | `confirm()` store + DialogHost | 仅一件事：有运行中任务时点"重启并安装" |

### 6.2 状态 × 界面矩阵

| phase | 关于面板 | 顶栏指示 | Toast |
|---|---|---|---|
| 空闲（未检查） | 检查按钮 + 上次检查时间 | 隐藏 | — |
| 检查中 | 按钮禁用 + spinner | 隐藏（避免启动闪动） | 不弹 |
| 下载中 | 进度条 + 标题 + 字节/速度/剩余 | 旋转图标（title 提示百分比） | 不弹 |
| 就绪 | 更新已就绪 + 重启并安装 / 稍后 / 跳过此版本 + 更新说明 | 强调色徽标，点击开操作浮层 | 弹（带重启并安装） |
| 已最新 | 成功色文案 + 检查时间 | 隐藏 | 仅手动检查时弹 |
| 失败 | 分类文案 + 重试 | 隐藏 | 仅手动检查时弹 |
| dev（未打包） | 按钮禁用 + 开发模式提示 | 隐藏 | 不弹 |
| 浏览器模式（无桥） | 整块隐藏 | 隐藏 | 不弹 |

关于面板必须把「检查中」与「下载中」拆成两个状态——现状二者共用一个禁用按钮，是进度不可见的根因。

### 6.3 关于面板

- **下载中**：标题行（"正在下载 v{版本}" + 取消按钮）；线性进度条；下方小字"{已下载} / {总量} · {速度} · 约剩 {时长}"。
- **就绪**：标题 + 主按钮（重启并安装）+ 次按钮（稍后）+ 文字按钮（跳过此版本）；下方为更新说明折叠区（默认收起，显示前若干行，可展开完整内容）。说明内容为纯文本 + 换行保真，不为低频场景引入 markdown 管线。
- **失败**：图标 + 分类文案 + 重试按钮。
- **开关行**：使用 `ToggleRow`，标题「自动检查更新」，描述写清完整行为（每次启动检查 / 后台下载 / 退出时安装），关闭后手动按钮仍在。

### 6.4 顶栏常驻指示

- 位置：Topbar 右侧图标按钮簇，规格与现有图标按钮一致。
- 只在「下载中」「就绪」两态出现；其余隐藏。
- 点击行为：下载中 → 打开设置并直达关于面板；就绪 → 打开操作浮层（重启并安装 / 稍后），不强制用户进设置页。
- 分区状态已提升到 ui-store（`openSettings(section?)` + `settingsSection`），符合"多入口对话框状态收敛 ui-store"的既有约定。
- 「稍后」按版本号记忆（本地瞬态，不入库）：同一版本本会话不再以徽标提醒，出现更高版本自动恢复。
- 「跳过此版本」持久化到 `settings.update.skippedVersion`（跨会话生效，见 §6.6）；与"稍后"共用同一静默判定。
- 快照回放（见 5.3）不触发 toast。

### 6.5 Toast 策略

- 「发现新版」保留（自动下载中）；「就绪」保留（带重启并安装），60s 后消失即可——顶栏徽标已兜底。
- 「检查中」「下载中」不弹（现状保持）。
- 自动检查失败不弹；手动检查失败必弹。
- 回放事件不触发 toast（见 5.3）。

### 6.6 危险与边界交互

- **重启并安装 + 运行中任务** → 走统一 `confirm()` store：标题「有正在进行的任务」，正文「重启会中断当前任务，是否继续？」，按钮「仍要重启」/「取消」。
  实现：`use-install-update` hook 提供统一动作（关于面板与顶栏指示共用，禁各入口自行弹窗）；"是否有回合在跑"由 `agent-run-store`（transient）承载，ChatPanel 发布 `status === 'streaming' || 'submitted'`，卸载时复位。
- **安装方式为静默**：确认通过后静默安装（`quitAndInstall(true, true)`），装完自动启动应用，不弹安装向导、沿用原安装目录。
- **取消下载**：无需二次确认；取消后回空闲态并显示一行"已取消下载"，不弹 toast。
- **跳过此版本**：仅在发现新版 / 就绪态出现（关于面板按钮 + 顶栏操作菜单项）；记录跳过的版本号（存 `app_settings` 的 `update.skippedVersion`），出现更高版本时因版本号不等自动失效。
  **语义是"不再提醒"，不阻断下载与安装**——差分下载成本低，且用户改主意时可点"取消跳过"或直接安装；关于面板显示"已跳过 v{版本}"并提供取消跳过。
- **上次检查时间**：关于面板灰字展示（主进程经 `update:getStatus` 下发 `lastCheckAt`）。

### 6.7 进度条呈现细节

- 进度小于 1% 时显示"正在准备…"，避免假死观感。
- 宽度变化走 MotionVault 过渡，避免每秒抖动。
- 预计剩余时间用滚动平均（库给的速率是全程均值，实时性一般）。
- 完成即替换为就绪态并保持，不自动消失。
- 需要新增字节与时长格式化工具（渲染层当前没有）。

### 6.8 无障碍

- 进度条使用 `role="progressbar"` + `aria-valuenow/min/max` + 本地化 `aria-label`。
- 状态文本容器加 `aria-live="polite"`（就绪 / 失败需可播报）。
- 顶栏徽标必须有 `aria-label` 描述状态，不能只靠颜色；键盘可 Tab、可 Enter 触发。
- 遵循 `11-a11y-spec.md`。

### 6.9 写法与令牌约束

- 配色一律走 Aurora 令牌（`text-muted-foreground` / `text-success-text` / `text-accent-text` 等），禁裸色与任意值。
- 条件 className 一律 `cn()`；按钮一律 `ui/button`（禁裸按钮）；图标钮使用 `size="icon"`。
- 需要新增 `ui/progress.tsx` 基元（`ui/` 目录当前无进度组件），并按 `10-component-design-spec.md` 登记。
- 需要同步更新的文档：`09-ux-interaction-spec.md` 的更新提示章节、`08-ux-guidelines.md` 的更新提示条目——两处目前都写成"仅 toast、无 DOM"，与目标形态不符。

## 7. 内容与容错

- **更新说明**：来源为 GitHub release body（即我们润色过的 CHANGELOG 段落），库会作为 releaseNotes 下发，直接展示。
  已实现：主进程 `toReleaseNotes` 归一化（字符串原样 / 分段数组用空行连接 / 无法识别 → null，不编造内容），经 payload `releaseNotes` 下发（available 与 downloaded 都带；取消时清空）；关于面板渲染折叠区（纯文本 + 换行保真，默认显示前 3 行，超过可展开）——不为低频场景引入 markdown 管线。
- **错误分类与本地化**：网络不可达 / 被限流 / 校验失败 / 磁盘不足 / 未知，各配一句可操作文案。现状是把库的英文原始 message 直接展示给用户。
  已实现：主进程 `classifyUpdateError` 按真实错误特征归类（HttpError 的 `statusCode` / `code`、Node 网络码、Electron `net::ERR_*` 文本、sha512 文本、ENOSPC/EDQUOT），经 payload 的 `errorKind` 下发；关于面板映射本地化文案，
  **unknown 分类保留原始 message**（这类问题需要用户把技术细节带到 issue，套"未知错误"反而丢线索，原始信息同时已进 `main.log`）。
- **磁盘预检**：下载前检查可用空间（阈值取包大小乘系数），避免磁盘满时才失败。

## 8. 可信、门禁与可观测

- **日志接管**：把 `autoUpdater.logger` 接到项目 `logger`。现状默认走主进程 `console`，而 electron-log 不劫持主进程 console，导致"是否走差分 / 为何回退全量 / 签名校验结果"在打包版全部丢失。
- **发布门禁补 blockmap**：Windows 必须存在 `.exe.blockmap`、macOS 必须存在 `.zip.blockmap`、Linux 校验 `latest-linux.yml` 含 `blockMapSize`。现状校验正则是"或"关系，blockmap 缺失也会发布成功，差分静默退化为全量。
- **release body 非空校验**：为空时更新说明是空白。
- **签名**：证书就位后配置发布者名称；当前未配置，未签名构建下 Windows 更新包不做发布者校验。
- **不新增攻击面**：若将来支持自定义更新源 URL，必须做 host 校验——仅允许 http/https，并拒绝 localhost、环回、私有与保留地址。设置是渲染层可写的，否则等于开放任意内网请求通道。

## 9. 缓存与磁盘

更新缓存常驻磁盘：`pending` 目录、Windows 的 `installer.exe`（约 328MB，差分基线）、macOS 的 `update.zip`（约 324MB）。需在「设置 → 数据」展示占用并提供清理入口，文案必须说明"删除后下次升级转为全量下载"。

已实现：`update:getCacheInfo` / `update:clearCache` 两个 IPC；主进程 `infra/update/update-cache.ts` 按 electron-updater 的口径解析目录（缓存根 `LOCALAPPDATA` / `~/Library/Caches` / `XDG_CACHE_HOME`，目录名取 `app-update.yml` 的 `updaterCacheDirName`），**解析不到即 path=null、界面隐藏该行**（不猜路径、不误删）；清理前走统一 `confirm()` 并说明全量代价。

**差分基准一致性看护（2026-09-19 新增，见 §14.7）**：`installer.exe`（基准安装包）与
`current.blockmap`（基准块图）可能版本错位（手动安装新版、全量回退后缓存残留等），此时
差分重建必然 sha512 失败并回退全量。每次发起下载前 `pruneStaleDifferentialBaseline()`
校验两者总大小，不一致即剔除陈旧块图（库随即下载与基准包同版本的块图，差分得以继续）。

## 10. 已拍板项

| 项 | 结论 | 说明 |
|---|---|---|
| 开关数量 | 单个 | 只做"自动检查更新"。理由：差分下载成本低；"这次先别下 / 先别装"由取消下载、稍后、跳过三个按钮承载；多一个开关会让界面状态与契约成本翻倍 |
| 开关默认值 | 默认开 | 已有用户升级后同样生效，无需迁移逻辑 |
| 安装方式 | 静默安装 | `quitAndInstall(true, true)`，与"重启即装"的按钮文案一致；per-user 安装无需管理员权限，不会弹 UAC；升级沿用原安装目录 |
| 长会话兜底 | 12h，默认开 | 不替代"每次启动检查"，只兜住长期不关窗的用户 |
| 跳过此版本 | 纳入（P1） | 否则"不装"的唯一手段是长期忽略，顶栏徽标会变成常驻骚扰 |
| `UpdateCheckRes` | 收敛枚举 | 实现只会返回 checking / error，另两个值永不出现 |
| 顶栏指示点击行为 | 下载中打开关于面板，就绪弹操作浮层 | 就绪是唯一需要用户动作的状态，给一个直达操作 |

## 11. 落地分期与文件清单

**P0（已完成，2026-09-18；实施记录见 §14）**

1. 启动检查 + 开关：`src/main/infra/update/update-service.ts`（调度与退避，开关以 `() => boolean` 注入）、`src/main/index.ts`（读取 `readSetting('update')` 并注入）、`packages/shared/src/schemas/settings.ts`（白名单）、`src/renderer/stores/persistent/settings-store.ts`（分组）、关于面板开关行。
2. 进度与状态：`packages/shared/src/schemas/update.ts`（payload 扩展 + 枚举收敛）、`update-service.ts`（接口扩展 + 状态快照 + `quitAndInstall` 改静默）、新增 `src/renderer/components/ui/progress.tsx`、新增字节格式化工具、关于面板进度条（拆分检查中 / 下载中）、顶栏常驻指示、取消下载。
3. 日志接管：`update-service.ts` 注入 logger 适配。
4. 发布门禁：`.github/workflows/release.yml` 的 publish job 强制 blockmap。

**P1（全部完成，2026-09-18；见 §14）**：~~跳过此版本~~、~~错误分类与本地化~~、~~上次检查时间~~、~~顶栏操作菜单~~、~~更新说明折叠区~~、~~重启确认对话框~~、~~缓存占用与清理入口~~。

**P2**：~~任务栏进度~~（已实现：下载中同步 `setProgressBar`，结束/取消/失败清除）、~~dev 更新链路可测性~~（见 §14.5）、签名与公证、自定义更新源的 host 校验。

## 12. 验收

- **单测**（fake updater + fake timers）：启动检查时序、退避重试、开关关闭时完全不检查、会话内去重、进度字段透传、快照读取、取消下载。
- **组件测试 + i18n 门禁**：进度条各状态渲染、开关行、错误分类文案双语一致。
- **打包真机**：安装旧版 → 升级到新版，核对 `main.log` 中的差分包大小，确认差分真实生效（dev 模式无法覆盖该链路）。

## 13. 明确不做

- 云端灰度放量、版本回滚、更新失败率统计（均需服务端）
- 自建更新服务器
- 自定义更新源 URL（P2 若做，必须带 host 校验）

## 14. 实施记录（2026-09-18）

P0 已落地，与本文档的两处机制偏差如实记录如下（均为实现期发现的更好做法）：

1. **新增两个 IPC 方法**：`update:cancel`（取消下载）与 `update:getStatus`（读状态快照）。
   前者是"取消下载"的必要条件；后者替代了"订阅时经事件通道回放"的方案（见 §5.3），
   用读语义天然避免回放触发提示。
2. **下载改由服务显式发起**：`start()` 置 `autoDownload = false`，在 `update-available`
   时由 `UpdateService` 用自持 token 调 `downloadUpdate`。原因是 electron-updater 未暴露
   取消 API——`cancellationToken` 在 `doCheckForUpdates` 内部新建且外部不可达，
   只有自持 token 才能实现取消（库文档明确支持该用法）。副作用：不再依赖库的自动下载分支。
3. **payload 增加 `cancelled` 阶段**：取消后就地显示"已取消下载"+ 检查入口，不弹 toast。
4. **棘轮基线显式放宽 1 次**：`scripts/check-file-size.baseline.json` 中
   `definitions.ts` 918 → 927、`mock-api.ts` 933 → 936（新增 IPC 方法必然增长单一真源
   定义表与 mock 镜像；`--update-baseline --force` 显式承认，diff 可见）。
   `check:functions` 的 mock-api 体量棘轮经"更新域 mock 提取到模块级"回落到 375 行（基线内）。

验收实测（2026-09-18）：`pnpm typecheck` / `pnpm lint` / `pnpm check:static`（13 项）/
`pnpm test`（shared 81 + main + renderer 1497 + integration 152 + scripts 158）/ `pnpm knip` 全部通过。
**打包真机的差分验证尚未执行**（需安装旧版触发一次真实升级），仍为待办。

### 14.1 P1 第一批（2026-09-18，已提交）

- **跳过此版本**：`settings.update.skippedVersion`（默认 null，写穿透落库）；判定集中在"顶栏徽标 + toast"
  两处静默，**不阻断下载与安装**（差分下载成本低、用户可随时取消跳过）；版本号不等即自动失效。
- **错误分类**：主进程 `classifyUpdateError`（导出可测）+ payload `errorKind`；关于面板映射本地化文案，
  unknown 保留原始 message。
- **上次检查时间**：`getStatus` 增加 `lastCheckAt`；关于面板灰字展示（复用 `formatDateTime`）。
- **顶栏操作菜单**：就绪态菜单补齐「跳过此版本」（原只有重启并安装 / 稍后）。

验收实测：`pnpm typecheck` / `pnpm lint` / `pnpm check:static` / `pnpm knip` 通过；
`pnpm test` = shared 81 + main 1842 + renderer 1502 + integration 152 + scripts 158 全绿。
新增测试：错误分类 5 组用例、`lastCheckAt` 记录、UpdateNotice 跳过/回放静默、`useUpdate` 快照含时间。

### 14.2 P1 第二批（2026-09-18，已提交）

- **重启确认**：新增 transient `agent-run-store`（ChatPanel 发布 `status`，卸载复位）+
  `use-install-update` hook（关于面板与顶栏指示共用同一危险操作语义，确认后才安装；
  弹窗走统一 `confirm()` store，`danger` 样式）。
- **更新说明**：主进程 `toReleaseNotes` 归一化 + payload `releaseNotes`（available/downloaded
  均带、取消清空）；关于面板折叠区（默认 3 行，纯文本换行保真）。
- **文档同步**：`08-ux-guidelines.md` / `09-ux-interaction-spec.md` 的更新提示条目由"仅 toast、
  无 DOM"改为三处接触点（此前描述与实现不符，属过期文档）。

验收实测：`pnpm typecheck` / `pnpm lint` / `pnpm check:static`（13 项）/ `pnpm knip` 通过；
`pnpm test` = shared 81 + main 1849 + renderer 1505 + integration 152 + scripts 158 全绿。
新增测试：`toReleaseNotes` 4 组、更新说明透传与取消清空、`use-install-update` 3 组（无回合直装 / 确认后装 / 取消不装）。

### 14.3 任务栏进度（2026-09-18，已提交）

- 下载中把百分比同步到任务栏（`BrowserWindow.setProgressBar(percent/100)`，Windows/macOS 生效、其他平台 no-op），
  就绪 / 取消 / 失败时清除（`-1`）。数据源复用既有进度事件，无新增 IPC、无新增契约。
- 验证：`pnpm typecheck` / `lint` / `check:static` / `knip` 通过；main 更新域 43 项测试通过
  （新增 2 项：进度同步与结束后清除、取消时清除）。

### 14.4 更新缓存占用与清理（2026-09-18，已提交）

- 新增 `src/main/infra/update/update-cache.ts`：按 electron-updater 口径解析缓存目录
  （平台缓存根 + `app-update.yml` 的 `updaterCacheDirName`），递归统计占用、清理目录；
  **解析不到 → path=null（界面隐藏该行），不猜路径、不误删**；测试注入临时缓存根，
  绝不触碰真实缓存目录。
- 新增 IPC `update:getCacheInfo` / `update:clearCache`（定义表驱动，handler 经 DI 注入读取/清理函数）。
- 设置 → 数据：展示"更新缓存：<占用>（N 个文件）"+ 清理按钮；清理前走统一 `confirm()`，
  文案说明"差分基线被删除，下次升级改为全量下载"；浏览器模式无桥时不请求。
- 棘轮：`definitions.ts` 927 → 941、`mock-api.ts` 936 → 938（新增 IPC 必然增长单一真源
  定义表与 mock 镜像，`--update-baseline --force` 显式承认，diff 仅此两行）。

验收实测：`pnpm typecheck` / `lint` / `check:static`（13 项）/ `knip` 通过；`pnpm test` 全链路通过。
新增测试：`update-cache` 8 项（解析三种形态 / 统计 / 清理 / 无法解析）、handler 2 项、data-section 2 项。

### 14.6 「无法关闭」弹窗修复（2026-09-19，真机反馈）

**现象**（1.1.2 → 1.2.0 真机升级实测）：点击「重启并安装」后，NSIS 安装器弹出
「Code Agent Desktop 无法关闭。请手动关闭它，然后单击重试以继续。」（重试/取消）。

**根因**（源码核实）：electron-updater 的 `quitAndInstall` 是"先 spawn 安装器、后
app.quit()"，而 NSIS 辅助安装器（`oneClick: false`）启动即尝试关闭应用并运行旧卸载器，
重试 5 次等不到退出就弹 `appCannotBeClosed`（`installUtil.nsh` 的 UninstallLoop，
`MessageBox MB_RETRYCANCEL "$(appCannotBeClosed)"`）。我们的退出链含异步清理
（IM 通道 3s 竞速 + 服务释放 + telemetry 关闭），应用在安装器检查时仍然存活。

**修复**：Windows 上安装改两段式——`quitAndInstall()` 只置标记（`quitForUpdatePending`）、
置关闭协商标志（渲染层入口已确认过）并 `app.quit()`；退出善后完成（文件锁释放）后由
`runDeferredInstall()`（index.ts 在 `app.exit(0)` 前调用）拉起静默安装器。非 Windows 保持
库的原生路径（mac 解包替换 / AppImage 替换自身，无此竞态）。

**差分判定的诚实说明**：1.1.2 → 1.2.0 这次升级**无法事后确证是否走了差分**——1.1.2 的
构建早于日志接管（§8），electron-updater 的 `Full: … To download: …` 日志走了控制台已丢失；
文件痕迹（缓存目录的 `installer.exe` 基线在位、pending 产物为全尺寸拼装结果、blockmap
时间线）只能证明"差分前置条件全部成立、库会尝试差分"，尝试成功与否不可回溯。**1.2.0 起
有日志接管**，下次升级（1.2.0 → 后续版本）的 `main.log` 会直接给出确证。

### 14.5 dev 更新链路可测性（2026-09-18，已提交）

- 背景：dev 模式此前直接返回"开发模式不支持自动更新"，进度条 / 取消 / 就绪态等 UI
  无法在开发环境端到端验证，只能打包后手工测。
- 实现：`UpdateStartOptions.devUpdateEnabled` → `autoUpdater.forceDevUpdateConfig = true`
  （electron-updater 据此改读 `app.getAppPath()/dev-app-update.yml`）；置位后 `check()`
  与启动调度都不再以 `app.isPackaged` 为硬门槛。**默认关闭**——dev 不发任何更新请求。
- 仓库新增 `dev-app-update.yml`（GitHub provider / channel 与 release 配置一致，
  `updaterCacheDirName` 用独立的 `code-agent-desktop-dev-updater`，不污染正式版缓存）。
- 启用方式：`CODE_AGENT_DEV_UPDATE=1 pnpm dev`（index.ts 读环境变量注入）。
  注意会真实访问 GitHub Releases，Windows 首次会整包下载（约 328MB）。
- 验证：main 更新域 52 项测试通过（新增 2 项：默认 dev 不调度且 `forceDevUpdateConfig=false`；
  置位后放行调度与手动检查）；`pnpm typecheck` / `lint` / `check:static` / `knip` / `test` 全绿。

### 14.7 真机三问题取证与修复（2026-09-19，用户反馈）

用户反馈三件事：① 差分是否真的实现；② 重启安装时后台进程没退干净、安装失败弹窗；
③ 差分"下载完"后又下了一遍全量。用用户机上的真实日志与缓存文件逐项取证，结论与修复：

**① 差分已实现且本次真实走了差分**（此前 §14.6 的"无法确证"至此有了确证）：
`main.log` 记录 `File has 1019 changed blocks` / `To download: 20,775 KB (6%)`，
即库确实按差分只下 6% 的块；且缓存的 `installer.exe`（基准包）sha512 与 v1.2.1
发布资产**逐字节一致**，基准前置条件成立。

**② 陈旧块图导致差分重建失败 → 自动回退全量（即用户看到的"下两遍"）**：
日志 `Cannot download differentially, fallback to full download: sha512 checksum
mismatch, expected jAZlt…(v1.3.0), got kQysv…`。**根因经可复现实验锁定**：
缓存的 `current.blockmap` 描述的是 **v1.3.0**（总大小 328,513,551，即上次下载时刷新），
而基准包 `installer.exe` 是 **v1.2.1**（328,509,173）——两者版本错位，重建出的文件
必然不是 v1.3.0。实验：用 v1.2.0 块图 + 本机基准包重放差分计划，**逐字节复现出日志
中的 got 哈希 `kQysv…`，且 changed blocks 数恰为 1019**（与日志完全吻合）；用 v1.2.1
块图重放则得到 expected `jAZlt…`。至此因果链闭合，非猜测。
修复：下载前 `pruneStaleDifferentialBaseline()`（§9）校验块图与基准包总大小，
不一致即剔除块图 → 库改从 release 拉与基准包同版本的块图 → 差分恢复正常
（剔除后最坏退化为与库原行为相同的全量下载，不会更差）。

**③ 退出后静默安装实际未生效**（用户感知为"进程没退干净导致安装失败"）：
用户机 `main.log` 末次安装走的是 electron-updater 自身的 `Auto install update on
quit`（`isForceRunAfter: false`），而我们 1.2.x 的退出链**根本没有接线
`runDeferredInstall()`**——`git grep` 证实该方法仅存在于 update-service.ts 与
其测试，index.ts 直到 v1.3.0 才加入调用。**且 v1.3.0 的接线也是无效的**：
`before-quit` 在 `disposeServices()` **之后**才调 `getUpdateService()`，而容器
dispose 会把 `updateService` 引用置空，取到的是**惰性新建的实例**——实例字段上的
挂起标志恒为 false，`runDeferredInstall()` 直接空返回。修复：挂起标志移交
`quit-state.ts` 模块级（`requestDeferredInstall` / `isDeferredInstallPending` /
`clearDeferredInstall`），跨实例、跨 dispose 存活；新增回归锚「挂起标志跨实例可见」。
副作用：NSIS 安装器的进程检查（`allowOnlyOneInstallerInstance.nsh`：进程可见时
Sleep 1s 后 force kill，命不到才弹 `appCannotBeClosed`）在延迟安装路径下应当能
自行通过；若仍出现弹窗，可用 `CODE_AGENT_SKIP_CLOSE_GUARD=1` 之外的现场日志继续定位。

**验证**：`update-service.test.ts` / `update-cache.test.ts` 共 59 项通过（新增 4 项：
跨实例挂起标志、陈旧基线剔除、一致基线保留、无基线/损坏块图不抛错）；用本机真实缓存
文件跑真实实现，判定为"陈旧（剔除）"符合预期；`pnpm typecheck` / `lint` /
`check:static` / `knip` / `test` 全绿。真机升级验证仍需下次发版后回归。

### 14.8 发布矩阵扩展到多架构（2026-09-20）

**目标产物**：Linux 6 个（AppImage / deb / rpm × x64 / arm64）、Windows 2 个
（x64 / arm64 `.exe`）、macOS 2 个（x64 / arm64 `.dmg`）。

**构建矩阵（release.yml 的 build job）**：

| job | runner | 架构 | 说明 |
|---|---|---|---|
| Windows | windows-latest | x64 + arm64 单 job | 见下方约束 2 |
| macOS | macos-latest | x64 + arm64 单 job | Xcode 原生支持交叉编译（v1.3.1 已实证） |
| Linux x64 | ubuntu-latest | x64 | 三种格式 |
| Linux arm64 | ubuntu-24.04-arm | arm64 | 原生 ARM64 runner（公共仓库免费） |

**三条实测/源码核实的约束（决定矩阵形态）**：

1. **原生模块必须为每个架构重新编译**：`@electron/rebuild` 的 buildArgs 硬编码
   `--build-from-source`，从不使用包内预编译产物；其 rebuildModule 对跨平台直接
   抛错。⇒ 每个架构都需要具备该架构工具链的 runner。本机（Windows x64，VS 仅含
   Hostx64/x86 目标）实测 arm64 构建失败（MSB8020 缺 v143 生成工具），而
   GitHub 的 windows-latest 镜像含 ARM64 MSVC 组件（官方镜像清单核实）。
2. **Windows 不可拆分为两个 job**（源码核实）：更新元数据写入按「文件名 + publish
   配置」累积 files，而架构前缀只对 **Linux** 追加（`getArchPrefixForUpdateFile`）
   ⇒ Windows 双 job 会各产一份 `latest.yml` 且内容互斥，合并时（`cp -n`）只有一份
   生效，另一架构拿不到自动更新。单 job 内双架构则在同一份文件里累积两组条目
   （与 macOS 的 `latest-mac.yml` 同机制，后者已由 v1.3.1 实测确认含 4 条目）。
3. **Linux 拆 job 安全**：其更新元数据按架构分文件（`latest-linux.yml` /
   `latest-linux-arm64.yml`），分开构建天然无覆盖；且能各自原生编译
   （node-pty 无 Linux 预编译产物）。

**多架构资源（顺带修复的既有缺陷）**：

- `@colbymchenry/codegraph`（代码智能 CLI 捆绑包）与 `@node-rs/jieba`（记忆引擎
  分词依赖）都按平台/架构分发为 optionalDependencies，pnpm 默认只装 host 架构那
  一份 ⇒ **交叉构建会把错误架构的二进制打进安装包**。这是既有缺陷：此前 macOS
  在单 job 内构建双架构，x64 包内实际是 darwin-arm64 的 codegraph（mac x64 用户
  codebase 工具会因架构不匹配失败）。
- 修复：`pnpm-workspace.yaml` 增 `supportedArchitectures.cpu: [x64, arm64]`
  （os 保持 `current`，不跨 OS 膨胀）；`prepare-codegraph.mjs` 改为按架构分目录
  部署（`resources/codegraph-{x64,arm64}`），electron-builder 侧用 extraResources
  的 `${arch}` 宏按构建目标选取（该宏经 `getFileMatchers → expandMacro(Arch[arch])`
  展开，源码核实）。`prepare-memory-hub.mjs` 同样为内层 install 声明双架构。
- **本机实证**：x64 构建产物内 `resources/codegraph/node.exe` 的 sha256 与
  `resources/codegraph-x64` 源完全一致（`b3094d0b…`），despite
  `resources/codegraph-arm64` 存在且内容不同（`6694c255…`）⇒ 宏按目标架构选取成立。

**资产完整性校验（release job）**：安装包按「平台-架构-格式」逐一断言（10 个组合），
更新元数据断言 4 份（latest.yml / latest-mac.yml / latest-linux.yml /
latest-linux-arm64.yml）。架构串取自 `getArtifactArchName(arch, ext)`（源码核实）：
x64 → AppImage/rpm 为 `x86_64`、deb 为 `amd64`；arm64 → rpm 为 `aarch64`、
AppImage/deb 为 `arm64`。

**验证状态（如实分工）**：electron-builder 配置经实际加载与完整构建验证（Windows
x64 全流程通过，产物内 codegraph 架构正确）；typecheck / lint / check:static（12 项）/
test 全链（shared 81 + main 1896 + renderer 1533 + integration 152 + scripts 158）/
YAML 解析校验全绿。**Windows arm64 交叉编译未在本机验证**——本机无 ARM64 工具链
（实测失败）；其可行性依据为官方镜像含 ARM64 组件，且 CI 的 e2e-electron job 会执行
`pnpm build:win`（现为双架构）作为合并前验证。Linux arm64 由原生 runner 保证，
同样待首次 CI/CD 运行确认。smoke 测试的产物路径解析已按架构自适应
（`win-arm64-unpacked` / `linux-arm64-unpacked`）。

### 14.9 多架构修复的正确性再修正（2026-09-20，CI 观察后）

§14.8 首次提交后，观察 CI 日志发现三处必须修正的问题（均为该次改动引入或未覆盖）：

**① CLI 架构标志与配置的 `arch` 是并集（不是覆盖）**。源码核实：
`targetFactory.computeArchToTargetNamesMap` 先用 CLI 的 raw keys 作 `defaultArchs`，
再遍历配置文件 `platform.target[].arch` 并**全部并入**结果。因此配置里写
`arch: [x64, arm64]` 会让 `electron-builder --win --x64` **同时构建 arm64**。
实测后果：CI 的 Linux x64 job 跑 `--linux --x64` 却产出了全部 6 个目标（含 arm64 的
deb/rpm/AppImage），其中 arm64 那份是在 x64 机器上"编译"的。
**修复**：从 `electron-builder.yml` 的 win/mac/linux 三个平台段**移除全部 `arch`
列表**（只声明格式），架构完全由脚本 CLI 标志决定——`build:win`/`build:mac`/
`build:linux` 显式传 `--x64 --arm64`，`build:*:x64`/`build:*:arm64` 传单个标志。
本机实测确认：修复后 `--win --x64` 只产出 `win-unpacked`（修复前会额外产出
`win-arm64-unpacked`）。

**② 跨架构"编译"会静默失败**。CI 日志证据：在 x64 runner 上为 arm64 目标
`@electron/rebuild` 报 `finished moduleName=node-pty arch=arm64` 仅耗时 **2.8s**
（对照：Windows 上真实 arm64 交叉编译 `node-pty` 耗时 **97.8s**），且全程无
gcc/aarch64 工具链调用痕迹——即**静默复用 host 架构的二进制**，构建日志无任何错误。
⇒ 产出的 arm64 安装包内是 x64 原生模块（ARM 用户装上即崩）。
**这就是 Linux 必须拆两个原生 runner job 的真实原因**（而不是"配置脆弱"）：
x64 job 无法为 arm64 产出正确二进制。

**③ 新增架构错配探针**（唯一可靠的检测手段）。新增
`scripts/lib/native-arch.ts`（ELF/PE/Mach-O 头解析）+ `scripts/check-native-arch.ts`
（遍历 `release/*-unpacked`，按目录名推断目标架构——`win-unpacked`=x64、
`linux-arm64-unpacked`=arm64，逐个读二进制头断言），接入 CI smoke job 与
release.yml build job（fail-closed）。
检查范围：node-pty 的 `build/Release/*.{node,exe}`（@electron/rebuild 产物）、
better-sqlite3 的编译产物或主动加载的 prebuild、codegraph 的 `node.exe`/`bin/codegraph`。
**双向验证**：本机 x64 产物通过；把 `win-unpacked` 改名为 `win-arm64-unpacked`
后精确报出 5 处错配（node-pty 4 个 + codegraph node.exe），退出码 1。

**CI 同步调整**：smoke job 改为构建**本机架构**（`build:win:x64` / `build:linux:x64`）
并加 `CODE_AGENT_TARGET_ARCHS` 收窄 codegraph 部署——CI 只验证能在 runner 上启动的
那份产物；arm64 由 release.yml 的 `ubuntu-24.04-arm` 原生 job 与 windows-latest
双架构 job 覆盖。

**验证**：`scripts/lib/native-arch.test.ts` 23 项（三格式 × 各架构 + 非二进制/截断
边界 + 目录名推断）；`check:native-arch` 在真实产物上双向验证通过；typecheck / lint /
test:scripts（181 项）全绿。**仍未在本机验证**：Windows/Linux 的 arm64 真实构建
（本机无 ARM64 工具链），待 release.yml 的对应 job 首次运行确认——届时
`check:native-arch` 会在架构错配时直接失败，不会再出现"静默产出坏包"。

### 14.10 Windows 1.3.1→1.3.2 升级失败：NSIS 长路径（2026-09-20，真机反馈）

**现象**：用户在 1.3.1 上点「重启并安装」升级 1.3.2，安装器弹出
「Failed to uninstall old application files. Please try running the installer
again.」并中止（错误码 2），无法升级。

**根因（已用真实 NSIS 完整复现）**：

`uninstallFailed` 消息来自 app-builder-lib 的 `installUtil.nsh:129`，`: 2` 是**旧
卸载器的退出码**。查 `uninstaller.nsh` 的更新模式路径（`--updated` 时）：

```
CreateDirectory "$PLUGINSDIR\old-install..."   ← CreateDirectory 失败即 Abort
Rename "$INSTDIR\<rel>" "$PLUGINSDIR\old-install\<rel>"
Abort `Can't rename ...`                        ← Abort 的退出码固定为 2
```

即：升级时旧卸载器**不删除文件**，而是把每个文件逐个重命名到临时目录，**任一失败
即 Abort**。

三条实测数据（本机真实测量）：
- 安装目录内**最深相对路径 = 206 字符**（`resources/memory-hub/node_modules/.pnpm/
  @opentelemetry+sdk-node@0.2_7e8bdd95…/node_modules/@opentelemetry/resources/…`）
- NSIS `$PLUGINSDIR` = **45 字符**（编译并运行一个探针安装器实测：
  `C:\Users\26592\AppData\Local\Temp\nsg6437.tmp`）
- 加上 `\old-install\`（13）⇒ 重命名**目标 = 264 > MAX_PATH 260**

**决定性实验**（用真实 makensis 编译探针，而非推理）：
```
--- long（206 字符相对路径）---
  CreateDirectory(full) FAILED   ← 目标超限
  Rename FAILED                  ← 卸载器在此 Abort → 退出码 2
--- short（对照）---
  CreateDirectory(full) OK       ← 短路径正常（证明是长度而非权限/占用）
```
另核实：用户系统 `LongPathsEnabled=1`，但旧卸载器二进制内**未声明 `longPathAware`**
（只搜到 `requestedExecutionLevel`）⇒ 该进程无法利用长路径支持。

**为什么此前没暴露**：升级路径的额外前缀此前**不在任何检查的模型里**——
`prepare-memory-hub.mjs` 原本只校验「安装前缀 + 相对路径」（全新安装），
故 1.3.1 能全新安装成功，而升级时多出的 58 字符前缀恰好把路径推过 260。

**修复（三层）**：

1. **缩短路径（根因）**：`scripts/prepare-memory-hub.mjs` 的嵌套安装声明
   `virtualStoreDirMaxLength: 24` ⇒ `.pnpm` 实体目录名从约 70 字符的
   `@opentelemetry+sdk-node@0.2_7e8bdd95…` 变为 33 字符的哈希 `_<32hex>`。
   实测最长相对路径 **206 → 188**。
   ⚠️ 连带改动：裁剪逻辑原本从目录名解析包名（`parseOwnPackageName`），哈希名下
   失效 ⇒ 增补**结构识别**（实体自身的包是其 `node_modules` 下唯一的**非链接**
   目录，用 realpath 判定——Windows 的 junction 用 `isSymbolicLink` 识别不到；
   实测 73 个实体该结构零歧义）。
2. **构建期断言（防回归）**：同文件新增**升级路径**校验——除原有的
   `相对路径 + 安装前缀(59)`，另算 `相对路径 + $PLUGINSDIR前缀(58)`，后者超 260
   即 **fail-closed**（`process.exit(1)`）。这是原检查的盲区所在。
3. **安装器逃生舱（`resources/installer.nsh`，经 `nsis.include` 注入）**：定义
   `customUnInstallCheck` 宏接管「旧卸载器非 0 退出码 → 弹窗 → Quit」逻辑，
   改为记录退出码 → 清理 `$INSTDIR` → `ClearErrors` → **继续安装**。
   理由：路径长度只是已知的一种失败原因（文件占用/权限/磁盘错误同样会返回非 0），
   而「装新版本前必须卸载干净旧版本」是优化而非正确性前提（新版安装器本就覆盖
   全部文件）。正常升级（`$R0 == 0`）不受影响。
   ⚠️ 三条实现约束（均由 makensis 编译失败/失败两次换来，见文件头注释）：
   ① 本文件注入在生成脚本**最前**（早于 `multiUser.nsh`），不能引用
   `${INSTALL_REGISTRY_KEY}` 等常量（"unknown variable" 警告即错误）；
   ② 清理必须在**安装器**侧——卸载失败走 `Abort`，`customUnInstall`（卸载器段）
   的代码根本不会执行；③ 辅助 `Function` 会被 "install function not referenced"
   误判（宏展开晚于该分析）⇒ 清理逻辑**内联在宏体内**。

**验证**：
- 路径：`prepare-memory-hub` 重跑实测「最长相对 188；全新安装 247 ≤ 260；
  升级 246 ≤ 260」全部通过
- 安装器：`electron-builder --win --x64`（真实 NSIS 目标）编译**成功**，且
  `builder-debug.yml` 证实 `!include ".../resources/installer.nsh"` 已注入
  （位置在所有 NSIS 模板之前，与约束 ① 一致）
- 产物：安装器内 `resources/memory-hub/node_modules/.pnpm/` 已是短名
  （如 `@ai-sdk+provider@3.0.16`），证明修复进入了最终产物
- 门禁：typecheck / lint / check:static（12 项）全绿

**仍未验证**：真机上从 1.3.1 升级到含本修复的版本（需发版后实测）。
本机无法直接验证升级路径——但三层修复中第 2 层会在构建期就拦住同类问题，
第 3 层保证即使再出现未知原因也不会阻断用户。

### 14.11 发布资产瘦身与命名规范化（2026-09-20）

**背景**：核对 v1.3.2 的 27 个资产（3.31GB）时发现三处冗余/缺陷：

1. **双架构通用安装包及其孤儿 blockmap**：`NsisTarget.shouldBuildUniversalInstaller`
   默认为 `true`——即使 target 按架构声明，仍会额外构建一个 686MB 的
   `Code-Agent-Desktop-Windows.exe`（同时支持 x64/arm64）。发布门禁白名单要求
   `Windows-` 后有架构段，**把通用包过滤掉了**；而 `*.blockmap` 是无差别通配符，
   于是它的 blockmap 被单独收进 release（0.6MB 孤儿资产）。
2. **`latest.yml` 悬空引用**：通用包被过滤但元数据里有它的条目 ⇒ `path` 与
   `files[0]` 指向一个**未发布**的文件。实际更新不受影响——electron-updater 用
   `name.includes(process.arch)` 在文件列表里选按架构包（`Provider.js:80`，
   已核实），但这是"靠匹配逻辑兜住"而非配置正确。
3. **无用的 dmg blockmap**：`dmg-builder/out/dmg.js:48` 默认也生成 blockmap，
   而 electron-updater 在 macOS 只对 **zip** 做差分
   （`MacUpdater.js:81`：`findFile(files, "zip", ["pkg","dmg"])`，dmg 被显式排除）
   ⇒ 两个 `.dmg.blockmap`（合计 0.6MB）永不被读取。

**修复（三处配置，均为官方开关，无自研）**：

| 配置 | 取值 | 作用 |
|---|---|---|
| `nsis.buildUniversalInstaller` | `false` | 不再产出双架构通用包 ⇒ 同时消除孤儿 blockmap 与悬空引用 |
| `dmg.writeUpdateInfo` | `false` | dmg 不生成 blockmap（zip 的 blockmap 保留，macOS 差分依赖它） |
| 五个 `artifactName` | 加 `${version}` | 资产名带版本号，便于用户在下载目录分辨 |

**最终命名**：`Code-Agent-Desktop-<平台>-<架构>-<版本>.<扩展名>`，共 10 个安装包：

```
Windows-x64-1.3.3.exe        Windows-arm64-1.3.3.exe
Linux-x86_64-1.3.3.AppImage  Linux-arm64-1.3.3.AppImage
Linux-amd64-1.3.3.deb        Linux-arm64-1.3.3.deb
Linux-x86_64-1.3.3.rpm       Linux-aarch64-1.3.3.rpm
macOS-x64-1.3.3.dmg          macOS-arm64-1.3.3.dmg
```

**命名约束（源码核实，决定了哪些写法可用）**：

- **架构串必须是字面量 `x64` / `arm64`**（Windows/macOS）：`latest.yml` 与
  `latest-mac.yml` 各自同时含两个架构的条目，electron-updater 靠
  `name.includes(process.arch)` 选包。写成「Apple芯片 / Intel芯片」等字样会让
  ARM Mac 匹配失败、回退取到 x64 包。
- **Linux 保留生态惯例串**（`x86_64` / `amd64` / `aarch64`）：由 `getArtifactArchName`
  按格式映射，且 Linux 的元数据**按架构分文件**（`latest-linux.yml` /
  `latest-linux-arm64.yml`），每个文件里只有一个 AppImage ⇒ 无论按名匹配还是
  回退取首个都必然选中正确架构（已用真实 yml 数据实测验证）。
- **版本号入文件名安全**：旧 blockmap 的 URL 由「新版本号字符串替换为旧版本号」
  推导（`Provider.js:24`），只要每个版本的资产名都带自己的版本号即可成立。
  ⚠️ 一次性代价：从 ≤1.3.3 升到带版本号的版本时，推导出的旧 blockmap URL 在旧
  release 里不存在（旧资产名无版本号段），差分失败一次并**自动回退全量下载**
  （不报错，只是多下一次完整包）。

**门禁同步（release.yml）**：安装包断言改为「平台-架构-版本」全匹配；新增
**负向断言**（命中即失败）——禁用通用包、其 blockmap、dmg blockmap、以及不带
版本号的旧命名（防止配置回退后资产名与文档脱节）；补 macOS zip 的显式断言。

**验证**：
- 门禁断言逻辑用真实数据双向验证：新命名资产全通过；旧命名 + 通用包 + dmg
  blockmap 的组合全部被拦（含逐条失败信息）
- 本机实构建（`electron-builder --win --x64`）实测：产物为
  `Code-Agent-Desktop-Windows-x64-1.3.3.exe`、**仅一个 target**（无通用包）、
  `latest.yml` 的 `path` 指向真实存在的包、无孤儿 blockmap；对真实产物跑门禁
  断言 `MISSING=0`
- typecheck / lint / 两份 YAML 解析全绿
