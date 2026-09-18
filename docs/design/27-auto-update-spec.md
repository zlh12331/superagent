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
- 「稍后」按版本号记忆（本地瞬态，不入库）：同一版本本会话不再以徽标提醒，出现更高版本自动恢复。跳过此版本归 P1。
- 快照回放（见 5.3）不触发 toast。

### 6.5 Toast 策略

- 「发现新版」保留（自动下载中）；「就绪」保留（带重启并安装），60s 后消失即可——顶栏徽标已兜底。
- 「检查中」「下载中」不弹（现状保持）。
- 自动检查失败不弹；手动检查失败必弹。
- 回放事件不触发 toast（见 5.3）。

### 6.6 危险与边界交互

- **重启并安装 + 运行中任务** → 走统一 `confirm()` store：标题「有正在进行的任务」，正文「重启会中断当前任务，是否继续？」，按钮「仍要重启」/「取消」。
- **安装方式为静默**：确认通过后静默安装（`quitAndInstall(true, true)`），装完自动启动应用，不弹安装向导、沿用原安装目录。
- **取消下载**：无需二次确认；取消后回空闲态并显示一行"已取消下载"，不弹 toast。
- **跳过此版本**：仅在发现新版 / 就绪态出现；记录跳过的版本号（存 `app_settings`），出现更高版本时自动失效；关于面板显示"已跳过 v{版本}"并提供取消跳过。
- **上次检查时间**：关于面板灰字展示。

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
- **错误分类与本地化**：网络不可达 / 被限流 / 校验失败 / 磁盘不足 / 未知，各配一句可操作文案。现状是把库的英文原始 message 直接展示给用户。
- **磁盘预检**：下载前检查可用空间（阈值取包大小乘系数），避免磁盘满时才失败。

## 8. 可信、门禁与可观测

- **日志接管**：把 `autoUpdater.logger` 接到项目 `logger`。现状默认走主进程 `console`，而 electron-log 不劫持主进程 console，导致"是否走差分 / 为何回退全量 / 签名校验结果"在打包版全部丢失。
- **发布门禁补 blockmap**：Windows 必须存在 `.exe.blockmap`、macOS 必须存在 `.zip.blockmap`、Linux 校验 `latest-linux.yml` 含 `blockMapSize`。现状校验正则是"或"关系，blockmap 缺失也会发布成功，差分静默退化为全量。
- **release body 非空校验**：为空时更新说明是空白。
- **签名**：证书就位后配置发布者名称；当前未配置，未签名构建下 Windows 更新包不做发布者校验。
- **不新增攻击面**：若将来支持自定义更新源 URL，必须做 host 校验——仅允许 http/https，并拒绝 localhost、环回、私有与保留地址。设置是渲染层可写的，否则等于开放任意内网请求通道。

## 9. 缓存与磁盘

更新缓存常驻磁盘：`pending` 目录、Windows 的 `installer.exe`（约 328MB，差分基线）、macOS 的 `update.zip`（约 324MB）。需在「设置 → 数据」展示占用并提供清理入口，文案必须说明"删除后下次升级转为全量下载"。

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

**P1**：更新说明折叠区、跳过此版本、重启确认对话框、错误分类与本地化、上次检查时间、缓存占用与清理入口。

**P2**：任务栏进度、`forceDevUpdateConfig` + `dev-app-update.yml` 让更新链路可在 dev 与 e2e 覆盖、签名与公证、自定义更新源的 host 校验。

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
