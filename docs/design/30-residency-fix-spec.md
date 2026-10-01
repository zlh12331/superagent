# 30 · 后台驻留缺陷修复规格（静默启动 / 唤回 / 开机自启）

- **状态**：缺陷已核实（含真机复验），**已实施并逐项验证**（2026-09-21）——结果见 §5.5，
  验证过程中踩的两个坑见 §5.6，附带修复见 §5.7。Linux / macOS 侧的真机行为仍待对应平台确认（§5.4）。
- **范围**：`src/main/window.ts`（窗口创建与关窗）、`src/main/index.ts`（单实例/activate/托盘装配）、
  `src/main/tray.ts`、`src/main/notification.ts`、`src/main/infra/autostart/`、
  `src/main/ipc/app.handler.ts`、`src/main/diagnostics.ts`、`resources/installer.nsh`、
  渲染层设置页与 settings-store
- **上游**：[28-tray-spec.md](./28-tray-spec.md)（托盘与关窗语义）、[27-auto-update-spec.md](./27-auto-update-spec.md)（更新链路与 `APPIMAGE` 口径）、
  [RELEASING.md](../../RELEASING.md)
- **不含**：本规格只修这条链上的缺陷，不改变 §6「明确不做」中列出的既定设计

## 0. 结论摘要

上一轮修复（`ac7f0d6`）把「开机自启 → 静默驻留托盘」的**平台结论**做对了（Windows 读取改用
`executableWillLaunchAtLogin` + 路径带引号、macOS 透传 `requiresApproval`、Linux 自实现 XDG
autostart）。但该链路上仍有 **2 个 P0 缺陷**，其中第一个让 `--hidden` 在最常见的场景下失效：

| 级别 | 缺陷 | 验证方式 |
|---|---|---|
| **P0** | 上次窗口是最大化状态 → `--hidden` 失效，开机照常弹窗 | 真实 Electron 探针（本机实测，见 §2.2） |
| **P0** | 隐藏状态下再次启动应用 → 窗口唤不出，用户以为没反应 | 同上 |
| **P1** | Linux AppImage 写入的自启路径是临时挂载点，登录时必然失效 | 源码 + AppImage 语义（无 Linux 真机，未实测） |
| **P1** | macOS 点 Dock 图标唤不回隐藏窗口；且 close 语义与 spec 28 的拍板项不一致 | 源码静态分析（无 macOS 真机） |
| **P2** | 托盘写入无日志无反馈（违反 spec 28 §9A）、诊断包缺关键证据、XDG/Hidden 细节、托盘缺 §6 要求的菜单项、两处入口无同步、卸载不清理 Run 项 | 源码核对 |
| **P3** | 死导出 ×2、测试盲区（E2E 不预置窗口状态、second-instance 零覆盖）、过期注释 ×3 | 源码核对 |

**共同性质**：全部是「验证机制与环境假设」层面的缺陷——`--hidden` 这条链从未被真实场景
（最大化状态、二次启动）覆盖过，所以问题一直没暴露。

## 1. 这条链在做什么

```
登录项注册（OS）            →  启动参数/系统事件        →  窗口创建        →  驻留与唤回
autostart.ts（三平台差异）      --hidden / AppleEvent      window.ts          tray / 单实例 / Dock
```

四个环节的契约：

1. **写入**：注册登录项时带上 `--hidden`（Windows）/ 依赖 `wasOpenedAtLogin`（macOS，ServiceManagement 不透传 args）/ 写 XDG `.desktop` 的 `Exec`（Linux）。
2. **判定**：`resolveStartHidden`（`autostart.ts:267`）→ `shouldStartHidden`（`:259`）。
3. **创建**：窗口照常创建（托盘与事件订阅依赖它），但静默启动时不显示（`window.ts:171-175`）。
4. **唤回**：用户点托盘 / 再次启动 / 点 Dock → 必须能把窗口带到眼前。

**P0 的两个缺陷分别打在环节 3 和 4 上。**

## 2. 基线事实

### 2.1 现状代码地图（file:line 均为核实值）

| 关注点 | 位置 | 现状 |
|---|---|---|
| 静默判定 | `window.ts:167-169` | `resolveStartHidden(app)`，仅记日志 |
| 显示时机 | `window.ts:171-175` | `ready-to-show` 里 `if (!startHidden) win.show()` |
| 最大化恢复 | `window.ts:207-209` | **无条件** `if (windowState.isMaximized) win.maximize()` |
| 关窗语义 | `window.ts:182-204` | 读 `readCloseAction()`（`:29-37`，读 SQLite `window` 域），**无 darwin 分支** |
| 状态持久化 | `window.ts:246` | `trackWindowState(...)`（监听 resize/move/maximize/unmaximize/close） |
| 单实例 | `index.ts:122-137` | 第二实例 `app.quit()`；主实例 `second-instance` 里只 `restore()`（仅最小化时）+ `focus()` |
| Dock | `index.ts:470-474` | `activate` 仅在**零窗口**时 `createWindow()` |
| 关窗退出 | `index.ts:492-496` | 非 darwin `app.quit()`；darwin 保持运行 |
| 托盘唤回 | `tray.ts:183-193` | `showMainWindow()`：restore → show → focus（**唯一正确的一份**），3 处调用（`:166` 左键、`:313` 打开会话、`:338` 通知点击） |
| 第三份副本 | `notification.ts:82-91` | 回合结束通知点击：restore → show → focus（正确但重复） |
| 托盘写入自启 | `index.ts:442-446` | `void setAutostartEnabled(...)`，fire-and-forget、无日志 |
| 依赖方向 | `window.ts:18` | **已 import `./tray`**（取 `notifyMinimizedToTray`）⇒ tray 不可反向 import window |

### 2.2 实测证据（本轮本机复验，非推测）

**Electron 语义依据**：`electron.d.ts:3101`（及 `:5893`）原文——
*"Maximizes the window. **This will also show** (but not focus) the window if it isn't being displayed already."*

**探针 A（对应 `window.ts:207-208`）**：`show:false` 窗口等 `ready-to-show` 后调用 `maximize()`：

```
beforeMax { visible: false, isMaximized: false }
afterMax  { visible: true,  isMaximized: true }   ← 静默启动被击穿
```

**探针 B（对应 `index.ts:130-133`）**：隐藏窗口先 `restore()`（若最小化）再 `focus()`，随后对照
`show()+focus()`：

```
beforeFocus    { visible: false }
afterFocus     { visible: false }   ← second-instance 现有写法：唤不出来
afterShowFocus { visible: true }    ← tray.ts:191-192 的写法：正确
```

**版本锚点**：`window.ts` / `index.ts` / `tray.ts` / `infra/autostart/` 自 `ac7f0d6` 后未被改动
（本轮流水线重构只触碰 `.github/`、`scripts/`、两个测试文件与文档）。

**附带事实**：`.e2e-user-data-hidden/window-state.json` 当前内容为
`{"x":213,"y":109,"width":1280,"height":802,"isMaximized":false}`——该文件由应用自身在退出时
写入（`trackWindowState`），E2E **从不预置**它，且该目录已 `.gitignore`（`.gitignore:81`）。

## 3. 缺陷清单

### P0-1 · 最大化状态击穿静默启动

**现象**：用户上次使用过最大化（极常见），下次开机自启时窗口照常弹出——正是该提交声称修掉的症状，
只是触发条件变成"上次最大化过"。

**根因**：`window.ts:207-209` 的 `win.maximize()` 位于 `ready-to-show` 判定之外，而 `maximize()`
自身会显示窗口（§2.2 探针 A）。因此 `startHidden=true` 时窗口先被 `maximize()` 显示，
`ready-to-show` 里的 `if (!startHidden)` 已无意义。

**用户影响**：开机自启的"静默驻留"在最常见的使用路径下失效。

**测试为何漏掉**：`e2e/electron-hidden-start.spec.ts` 从不预置 `window-state.json`，也不做最大化，
它专属的 userData 目录里 `isMaximized` 恒为 `false` ⇒ **结构上无法发现该缺陷**。

**顺带缺陷（同处修复）**：非静默路径下 `maximize()` 在窗口创建后立即执行，会让窗口在首帧渲染前
就弹出，破坏了 `show:false + ready-to-show` 的防闪设计（原注释"必须在 show 前"的意图被它自己破坏）。

### P0-2 · 再次启动唤不回隐藏窗口

**现象**：开机自启静默驻留后，用户点桌面图标 / 开始菜单 → 什么都没发生（易被判断为"应用卡死"）。

**根因**：`index.ts:130-133` 只做 `restore()`（且仅当 `isMinimized()`）+ `focus()`。经
`closeAction=minimize` 隐藏的窗口（`window.ts:190` 的 `win.hide()`）**既不可见也未最小化**，
`focus()` 不会让它出现（§2.2 探针 B）。

**连带影响**：同一条路径上的 `broadcastDeepLink`（`index.ts:136`）会把 `code-agent://` 投递给
隐藏窗口——渲染层确实收到了（导航状态会变），**但用户看不到**。协议唤起同样表现为"没反应"。

**对照**：托盘左键走 `tray.ts:183-193`，`show()` 在前，是正确的；`notification.ts:82-91` 也正确。
三份实现里只有 `second-instance` 这一份缺 `show()`。

### P1-1 · Linux AppImage 的自启路径是临时挂载点

**现象**：AppImage 用户开启自启后，下次登录不会启动；且开关状态不可信。

**根因**：`autostart.ts` 全文用 `deps.execPath` 构造 `Exec`（`:139` 写入、`:165` 读取、`:227` 比对、
`:241` 写入路径），而 `createAutostartDeps()` 的 `execPath: process.execPath`（`:86`）在 AppImage
运行时指向 squashfs 挂载点 `/tmp/.mount_xxx/...`——**每次启动都变**。

**三重后果**：

1. 写进 `~/.config/autostart/*.desktop` 的路径在下次登录时不存在 ⇒ 自启静默失效；
2. 读取时用当前 `execPath` 逐字符比对（`isLinuxEntryActive`）⇒ 重启后路径不同，开关显示"未启用"；
3. 文档所称的"自愈路径"（再点一次重写文件）实际失效——它写出的仍是临时路径。

**项目已有正确口径**：`27-auto-update-spec.md:40` 与 electron-updater 都用 `APPIMAGE` 环境变量
定位真实文件；autostart 模块未采用。deb / rpm 安装不受影响（`execPath` 是稳定的安装路径）。

### P1-2 · macOS：Dock 唤不回 + close 语义与拍板项不一致

**现象 a**：静默驻留后点 Dock 图标没有任何反应。

**根因 a**：`index.ts:470-474` 只在 `getAllWindows().length === 0` 时重建窗口；窗口存在但隐藏时
不做任何事。

**现象 b**：macOS 点红叉变成"隐藏窗口"（沿用 `closeAction` 默认值 `minimize`），与 spec 28 的
拍板项不符。

**根因 b**：`window.ts:182-204` 的关窗处理没有 darwin 分支，三平台都读 `closeAction`。
spec 28 明确两处：§3.2:68-69「**darwin 不参与**：macOS 原生惯例即"关窗不退出"，不读 `closeAction`，
保持平台行为」、§10:243 决策表同义。

**为什么在自启场景更致命**：登录后窗口本就隐藏，用户的第一手势就是点 Dock 图标，而此时无任何反馈。

### P2-1 · 托盘写入自启无日志（违反 spec 28 §9A）

`index.ts:442-446` 是 `void setAutostartEnabled(...)`，且 `autostart.ts` **全文件 0 处 logger**
（读失败的 catch 也静默）。而 spec 28 §9A:232-233 要求「最小化触发、托盘退出点击、状态机转移、
**开机自启开关变更**——全部 `logger.info` 落 `main.log`」。

后果：「开机自启不生效」这类报障拿不到关键证据。渲染层发起的写入经 IPC 返回结果，托盘发起的
则完全无痕（失败只在下一次右键重建时以"开关回到原位"体现）。

### P2-2 · 诊断包缺自启与窗口状态

`src/main/diagnostics.ts` 的 `exportDiagnosticsPackage`（`:150-180`）只收 `manifest.json`、
`settings.json`、`logs/*.log`（头注释 `:9-11` 明示不收 DB/keychain）。**不含**开机自启状态与
`window-state.json`——而这两者恰是本次两个 P0 的判据来源。

### P2-3 · Linux 未遵循 `XDG_CONFIG_HOME`

`autostart.ts:34` 硬编码 `['.config','autostart',...]`，`:185-187` 拼在 `homedir()` 下。
同一仓库对缓存目录已按 `XDG_CACHE_HOME` 处理（`update-cache.ts:43`），口径不一致。

### P2-4 · Linux 不认 `Hidden=true`

`isLinuxEntryActive`（`:213-221`）只识别 `X-GNOME-Autostart-enabled=false`。KDE 等桌面用
`Hidden=true` 禁用条目 ⇒ DE 侧关掉后，应用内开关仍显示"已启用"。

另有残余不可验证性：精简桌面可能根本不跑 XDG autostart，此时开关显示"开"却不会启动
——这一点建议在文案/文档如实说明，不要再留一种"假成功"（列入 §6）。

### P2-5 · 托盘菜单缺「关闭时最小化到托盘」

spec 28 §6:126-137 的菜单形态里，两个勾选项并列：

```
开机自启                    ☑
关闭时最小化到托盘          ☑
```

`tray.ts` 只实现了「开机自启」（`:288-297`）；§10:245-246 也把"两个勾选项"作为一项决策记录。
另外 §6:145-146 明确两者**数据来源不同**（前者读 OS 登录项，后者读 `settings.window.closeAction`），
不得混用存储。

### P2-6 · 两处入口无同步推送

spec 28 §7:161-164 声明「两处没有独立状态，天然同步」。实际：

- **自启**：`general-section.tsx:75-86` 是 `useEffect(..., [])`——仅挂载时读一次。托盘改动后，
  若设置页正开着则显示旧值（点一下会因写后回读而自愈，但用户看到的是错的）。
- **关窗行为**：`general-section.tsx:70-71` 读 zustand persistent store。若按 P2-5 让托盘写入
  `window.closeAction`，则主进程改了 SQLite，渲染层 store 仍持旧值 ⇒ **后续任何其它设置变更都会把
  旧的 `closeAction` 写回**（`setWindow` 是"合并 + 整体持久化"，`:497-501`），静默覆盖托盘的改动。
  这是**丢更新**，不是显示问题。

### P2-7 · 卸载不清理 `HKCU\...\Run`

`resources/installer.nsh`（66 行）只有 `customUnInstallCheck` 系列宏，无卸载清理。
启用过自启的用户卸载后会留下指向已删除 exe 的启动项。

### P3-1 · 死导出

| 符号 | 位置 | 状态 |
|---|---|---|
| `linuxAutostartFileExists` | `autostart.ts:289-291` | 全仓零调用（连测试都没引用），注释称"供诊断/测试断言" |
| `SetLoginItemSettingsResSchema` | `packages/shared/src/schemas/app.ts:123` | 零引用（set 的响应实际复用 `LoginItemSettingsResSchema`） |

`knip` 只在 files/deps/binaries 级卡关，exports 级需人工审阅 ⇒ 逃过门禁。

### P3-2 · 测试盲区

- E2E 不预置 `window-state.json`（全仓唯一写入方是应用自身）⇒ P0-1 无法被覆盖（§3 P0-1 已述）。
- `second-instance` **全仓零测试**（仅源码引用）⇒ P0-2 无法被覆盖。
- 托盘无测试文件（主进程根目录只有 `diagnostics.test.ts`）。
- macOS / Linux 分支只有单测（26 例），且断言的是"请求形状"，不是真实 OS 行为。

### P3-3 · 过期注释

| 位置 | 问题 |
|---|---|
| `window.ts:166` | 注释称"用户点托盘「打开主窗口」即可唤出"——**托盘菜单里没有该项**（spec 28 §6 的菜单形态里也没有） |
| `schemas/app.ts:1-5` | 文件头只写"应用域响应 payload（app:getInfo）"，未提登录项等方法 |
| `autostart.ts:288` | 随死代码删除一并移除 |

## 4. 修复方案

### 4.0 核心抽象：把「唤回主窗口」收敛为唯一实现

现状三份副本行为不一致（§2.1），其中一份就是 P0-2 的根因。故第一步是建立唯一实现。

**新建叶子模块 `src/main/window-show.ts`**（只依赖 `electron` 与 `utils/logger`）：

```ts
/** 静默启动时为 true：窗口当前隐藏，但下次唤回时应回到最大化态 */
let maximizeOnNextShow = false;

/** 由 window.ts 在静默启动且上次为最大化时标记 */
export function markMaximizeOnNextShow(): void;

/** 有窗口则 restore（仅最小化时）→ 应用 pending maximize → show → focus */
export function showMainWindow(): void;

/** 无窗口则 create()，否则 showMainWindow()——供 Dock / 二次启动 / 托盘共用 */
export function bringMainWindowToFront(create: () => void): void;
```

`showMainWindow` 内应用 pending 标志时调用 `win.maximize()`：该调用**同时完成"显示"与"回到最大化态"**，
且因为没有先 `show()` 普通尺寸，不存在跳变（副作用正是 P0-1 的成因，在这里被有意利用）。

**为什么新建模块而不是导出 `tray.ts` 的实现**：`window.ts:18` 已 import `./tray`
（`notifyMinimizedToTray`），若 tray 反向 import window 即构成循环。新模块是叶子，
`window.ts` / `tray.ts` / `notification.ts` / `index.ts` 各自 import 均无环。

`notification.ts:78-88` 与 `tray.ts:183-193` 的重复实现同时改为调用它。

### 4.1 P0-1：最大化解耦于静默启动（`window.ts`）

```ts
win.once('ready-to-show', () => {
  if (startHidden) return;                      // 静默启动：保持隐藏，等用户唤回
  if (windowState.isMaximized) win.maximize();  // 先最大化再显示，避免普通尺寸跳变
  win.show();
});
```

```ts
// 替换原 window.ts:207-209
// ⚠️ 静默启动时不能在此 maximize：Electron 的 maximize() 自身会显示窗口（electron.d.ts:3101），
// 会让 --hidden 失效。改为记下"下次唤回时最大化"，由 window-show.showMainWindow 应用。
if (startHidden && windowState.isMaximized) markMaximizeOnNextShow();
```

**顺带修好**：非静默路径的最大化移到 `ready-to-show` 之后，窗口不再于首帧渲染前弹出。

**与持久化的关系**：`trackWindowState` 在 `window.ts:246` 同步注册（早于 `ready-to-show` 异步触发），
故移动后 maximize 事件会被捕获并写盘——写入值与既有一致（关闭时兜底 persist 本来也会读到同一状态），
无行为变化。

### 4.2 P0-2：二次启动改用唯一实现（`index.ts`）

```ts
app.on('second-instance', (_event, argv) => {
  bringMainWindowToFront(createWindow);   // 原：restore(仅最小化) + focus ⇒ 隐藏窗口唤不出
  broadcastDeepLink(parseDeepLink(argv.find((a) => a.startsWith('code-agent://')) ?? ''));
});
```

**顺序不变**（先显示再广播），符合 spec 28 §6.1:154-156「先 `show` 窗口」的要求，同时修好
"协议唤起到了但看不见"。

### 4.3 P1-2：macOS 两处（`index.ts` + `window.ts`）

```ts
// index.ts:470-474
app.on('activate', () => {
  bringMainWindowToFront(createWindow);   // 零窗口则重建；窗口隐藏则唤出
});
```

```ts
// window.ts 关窗处理器：在既有 isQuitting/isCloseConfirmed/E2E 豁免判断之后
// darwin 不参与（spec 28 §3.2:68-69 / §10:243）：macOS 关窗 = 关闭窗口、应用留存，
// 不读 closeAction。window-all-closed（index.ts:492-496）在 darwin 不退出，语义自洽。
if (process.platform === 'darwin') return;
```

**行为变化与重建路径**：macOS 点红叉后窗口**被销毁**（此前是隐藏），重建由
`activate`（Dock）、托盘左键、再次启动三条路径覆盖，均已走 `bringMainWindowToFront`。
运行中的回合不受影响（回合在主进程），但 mac 上不再弹"中断回合"确认——关窗 ≠ 退出，无中断语义；
退出仍走 `before-quit` 协商（`index.ts:535`）。

### 4.4 P1-1：AppImage 用 `APPIMAGE`（`autostart.ts`）

```ts
/**
 * 自启注册的可执行路径
 *
 * AppImage 运行时 process.execPath 指向临时挂载点（/tmp/.mount_*），每次启动都变——写进
 * ~/.config/autostart 的路径下次登录必然失效。AppImage 运行时把真实文件路径放在 APPIMAGE
 * 环境变量（electron-updater 亦以此定位，见 27-auto-update-spec.md:40）；deb/rpm 无该变量，
 * 回退 execPath。
 */
export function resolveAutostartExecPath(platform: NodeJS.Platform, appImage: string | undefined): string;
```

`createAutostartDeps()` 用 `resolveAutostartExecPath(process.platform, process.env['APPIMAGE'])`
替换 `execPath: process.execPath`。参数化以便单测注入（该模块现有风格即为纯注入）。

### 4.5 P2-3 / P2-4：Linux 细节（`autostart.ts`）

- deps 增可选 `xdgConfigHome?: string`；`createAutostartDeps()` 从 `process.env['XDG_CONFIG_HOME']` 取。
- `linuxAutostartFilePath` = `join(xdgConfigHome || join(homeDir, '.config'), 'autostart', '<name>.desktop')`
  ——口径与 `update-cache.ts:43` 处理 `XDG_CACHE_HOME` 一致。
- `isLinuxEntryActive` 增一条：`/^Hidden\s*=\s*true\s*$/m` 命中即判未启用（KDE 等的禁用写法）。

### 4.6 P2-1 / P2-2：可观测性

**日志（`autostart.ts` 引入 logger，`index.ts` 补齐托盘路径）**：

- `utils/logger.ts:54-55` 已有 `VITEST` / `NODE_ENV=test` 守卫 ⇒ 引入 logger 不会污染测试日志。
- `setAutostartEnabled`：成功 `logger.info({ platform, enabled, state })`；异常 `logger.error` 后 rethrow。
- `readAutostartState` 的 catch（`:118-120`）：`logger.warn({ error })`——把"读失败"从静默变为可查
  （**UI 语义不变**：仍按未启用显示）。
- `index.ts:442-446`：`void` 改为带 `.then/.catch`，catch 记日志并防 unhandled rejection；
  保留"下次菜单重建时按真实读取回显"的既有语义。
- 满足 spec 28 §9A:232-233。

**诊断包（`src/main/diagnostics.ts`）**：

- 新增 `runtime.json`：`{ autostart, windowState }`。
  - `autostart` 由**调用方读好传入**（`ExportDiagnosticsOptions`（`:63-68`）加可选字段，
    `app.handler.ts:131` 传 `await readAutostartState(createAutostartDeps())`）——避免 diagnostics 依赖
    autostart 与 electron `app` 桩。
  - `windowState` 由 diagnostics 直接读 `join(userDataPath, 'window-state.json')`，读不到则记 `null`。
- 同步更新 `diagnostics.test.ts` 的 zip 条目断言（`:115-117`、`:146-147`）。

### 4.7 P2-5 / P2-6：托盘菜单项 + 两层状态推送同步

**a) 关窗行为开关（`window.ts` 导出 + `tray.ts` 菜单）**

- `window.ts` 导出 `readCloseAction`（现为私有 `:29-37`），`index.ts` 复用它（index → window 已存在）。
- `TrayDeps`（`tray.ts:83-104`）增 `getCloseAction(): 'quit' | 'minimize'` 与 `setCloseAction(v): void`；
  菜单在「开机自启」之后插入同形态 checkbox（位置依 spec 28 §6:134）。
- `setCloseAction` 的实现必须**读改写**（`writeSetting('window', { ...current, closeAction })`），
  不覆盖同域其它字段。

**b) 新增 2 个 IPC 推送事件**（严格按项目定义表三步走，`channels` / preload / 类型推导全自动）

| payload | meta.ts | definitions.ts |
|---|---|---|
| `app:event:loginItemChanged`（复用 `LoginItemSettingsResSchema`） | 一行 `event(...)` | 一行 `withPayload(...)` |
| `settings:event:changed`（`{ key: string; value: unknown }`） | 同上 | 同上 |

对照样板：`update:event:status`（`meta.ts:221` / `definitions.ts:1023-1027`）。
⚠️ **`src/renderer/dev/mock-api.ts` 必须同步**——`IpcApi` 形状变化会让它类型报错，这是强制同步点。

**c) 主进程发送**：新增 `src/main/main-events.ts`（照 `deep-link.ts:66-74` 的广播形态：遍历
`BrowserWindow.getAllWindows()` + `isDestroyed` 守卫）：

```ts
export function broadcastLoginItemChanged(state: LoginItemSettingsRes): void;
export function broadcastSettingChanged(key: string, value: unknown): void;
```

**只在"主进程主动变更"时调用**（即托盘的两条写入路径）；渲染层发起的写入不回灌，避免回声。
现状核对：主进程 `writeSetting` 调用点只有 `tray.ts:330`（首帧引导标记，渲染层不读）、
`im-allowlist-pref.ts:45`（不在设置 store 域内）、`settings.handler.ts:51`（渲染层发起）——
**本次新增的 `window.closeAction` 是唯一需要广播的主进程主动写入**，事件本身仍按通用形态设计以便复用。

**d) 渲染层订阅**：

- 自启状态是 `general-section.tsx:73` 的**局部 useState** ⇒ 让该组件自己订阅
  `subscribeLoginItemChanged`，收到即 `setAutostart(payload)`。不为此新建全局 store 切片。
- 关窗行为在 store ⇒ 新增 store action `applyMainSettingChange(key, value)`（**只 `setState` 不 persist**，
  `window` 域用 `{ ...current, ...patch }` 合并），由新增 `src/renderer/hooks/use-settings-bridge.ts`
  订阅后调用，挂载点 `AppShell.tsx:107` 之后（与 `useAgentBridge` / `useUpdateBridge` 同列）。
- ⚠️ **不能复用 `applySettingsSnapshot`**：`settings-store.ts:508+` 是**整快照覆盖**（缺键回落
  `DEFAULT_SETTINGS`），单键调用会把 `theme` / `language` / `ai` 等重置为默认值。

### 4.8 P2-7：卸载清理 `HKCU\...\Run`

`resources/installer.nsh` 增：

```nsis
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
!macroend
```

- 值名依据：Electron 用 `app.getName()`（优先 `productName`），而 `electron-builder.yml:28`
  为 `productName: Code Agent Desktop`、`:25` 为 `appId: com.code-agent.desktop`。
- 必须遵守该文件头 `:24-39` 记录的三条约束（本文件注入在生成脚本**最前**，不能引用
  `${INSTALL_REGISTRY_KEY}` 等后续才定义的常量；`customUnInstall` 在卸载器段可用，
  已在 `app-builder-lib` 模板 `templates/nsis/uninstaller.nsh:156-157` 取证）。
- **验证关口**：`pnpm build:win:x64`——项目把 NSIS 警告当错误，变量不可用会直接编译失败。
- 若 `${PRODUCT_NAME}` 在卸载器段不可见：退化为 `EnumRegValue` 遍历 Run 子键、删除数据中含
  `$INSTDIR` 的值（并在文件中记录原因）。

### 4.9 P3：清理与回归锚

- 删 `linuxAutostartFileExists`（`autostart.ts:289-291`）与 `SetLoginItemSettingsResSchema`
  （`schemas/app.ts:123`）。
- 修 3 处过期注释（§3 P3-3）；`window.ts:166` 改为如实描述（左键唤回 / 右键菜单项清单），
  **不加**「打开主窗口」菜单项（§6）。
- E2E 补两个回归锚（§5）。

## 5. 验证方案

### 5.1 单元测试

| 新增/增强 | 断言要点 |
|---|---|
| `src/main/window-show.test.ts`（新） | `showMainWindow` 在无窗口 / 已销毁时安全返回；有窗口时按 restore（仅最小化）→ show → focus 顺序调用；`markMaximizeOnNextShow` 后 maximize 只生效一次（第二次唤回不再 maximize）；`bringMainWindowToFront` 在零窗口时调用 `create` |
| `autostart.test.ts` 补 4 例 | ① `resolveAutostartExecPath('linux', '/tmp/.mount_x/app')` 用 APPIMAGE；② 无 APPIMAGE 时回退 execPath；③ `xdgConfigHome` 覆盖路径；④ `Hidden=true` 判未启用 |
| 渲染层 | `applyMainSettingChange` 单键回灌不改动其它域（防"整快照覆盖"回归） |

风格照现有 `autostart.test.ts` 的 fake deps（`createFakeAdapter` / `createDeps`，`beforeEach` 建临时
home、`afterEach` 清理）。

### 5.2 E2E 回归锚（`e2e/electron-hidden-start.spec.ts`）

1. **P0-1 锚**：启动前把 `<E2E_USER_DATA>/window-state.json` 写为含 `isMaximized: true` → 带 `--hidden`
   启动 → 断言 `isVisible() === false`。当前实现下此用例必失败（即缺陷证据）。
   ⚠️ **必须在每次启动前重写该文件**（并在 `afterEach` 删除）：应用退出时会按实时状态回写
   `isMaximized:false`，只种一次的话第二轮失效，锚会静默退化。
2. **P0-2 锚**：先 `--hidden` 启动并断言隐藏；再用仓库的 electron 二进制 + 相同
   `CODE_AGENT_USER_DATA` spawn 第二个进程（它会即刻退出，单实例锁生效）→ 断言第一个实例的窗口
   变为可见。二进制路径经 `require('electron')` 取得（该包导出路径字符串）；沿用该 spec 的
   `DEBUG_PORT = 9225` 避免与其它 spec 冲突；第二实例的回收沿用 `e2e/helpers/close-electron.ts`。

### 5.3 门禁与真机复验

依次全绿：`pnpm typecheck` → `pnpm lint` → `pnpm check:static`（12 项）→ `pnpm test:scripts` →
`pnpm test:main` → `pnpm test:renderer` → `pnpm knip`（复核死代码清理）→ `pnpm depcruise`
（复核新模块未引入环）→ `pnpm build:win:x64`（NSIS 编译，§4.8 的关口）→
`pnpm test:e2e:electron`（含两个新锚）。

本机可做的真机复验：用现有构建产物 + 真实 Electron 探针（方式同 §2.2）确认
"最大化 + `--hidden` 不再显示"，以及第二实例能把隐藏窗口唤出——即两个 P0 的反向验证。

### 5.4 本机无法验证（如实标注）

- **Linux**：AppImage 的 `APPIMAGE` 变量实际取值、`XDG_CONFIG_HOME` 在真实 DE 下的行为、
  KDE `Hidden=true` 语义 —— 逻辑由单测覆盖，真机行为待对应平台确认。
- **macOS**：`activate` 的实际触发时机、`wasOpenedAtLogin` 在 macOS 13+ SMAppService 路径下的
  可靠性（静默启动的唯一判据）——同样只能逻辑覆盖。

## 5.5 实施结果（2026-09-21 落地，含实测记录）

**§3 的 13 项缺陷全部修复**。逐项验证结果：

| 项 | 验证方式 | 结果 |
|---|---|---|
| P0-1 最大化击穿静默启动 | E2E 锚（预置 `isMaximized:true` + `--hidden`）+ **反向验证** | ✅ 通过（Linux 六平台 CI 亦通过）；退回旧写法后锚立即失败（`Expected:false, Received:true`） |
| P0-1 的防误伤锚（常规启动仍显示） | E2E：不带 `--hidden` + 上次最大化 ⇒ 窗口显示 | ✅ 通过；**最大化态断言限定非 Linux**（xvfb 无 WM，见 §5.6 ④） |
| P0-2 二次启动唤不回 | E2E 锚（隐藏启动 → execFile 起第二实例 → 断言可见）+ **反向验证** | ✅ 通过；退回旧写法后锚失败（`Expected:true, Received:false`） |
| P1-1 AppImage 路径 | 单测：`resolveAutostartExecPath` 5 例（含 AppImage 场景下写出的 `.desktop` 不含 `/tmp/.mount_`） | ✅（真机 AppImage 运行待 Linux 平台确认） |
| P1-2 macOS Dock / 关窗语义 | 单测（`bringMainWindowToFront` 零窗口重建）+ 代码级核对 spec 28 §3.2/§10 | ✅（macOS 真机行为待确认） |
| P2-1 自启日志 | 单测 3 例（成功 info / 抛错 error 后 rethrow / dev 守卫记 info） | ✅ |
| P2-2 诊断包含自启与窗口状态 | 单测（`app.handler.test` 断言新增 `autostart` 字段透传）+ zip 新增 `runtime.json` | ✅ |
| P2-3 XDG_CONFIG_HOME | 单测 2 例（设置则用 / 未设置回退 `~/.config`） | ✅ |
| P2-4 `Hidden=true` | 单测 4 例（含 `Hidden=false` 不误判） | ✅ |
| P2-5 托盘「关闭时最小化到托盘」 | 代码 + 双语文案表；构建通过 | ✅（托盘 UI 交互待真机目检） |
| P2-6 两处入口同步 | 新增 2 个 IPC 推送事件 + `useSettingsBridge` + `applyMainSettingChange`；单测 6 例 | ✅ |
| P2-7 卸载清理 HKCU Run | **真机端到端**：静默装 → 注册表有值 → 静默卸 → 值消失、目录删除 | ✅ 见下方"探针坑" |
| P3-1 死导出 | 删除 `linuxAutostartFileExists`、`SetLoginItemSettingsResSchema`；`knip` 通过 | ✅ |
| P3-2 测试盲区 | 新增 window-show（10 例）、autostart（+14 例）、settings-store（6 例）、E2E（+3 例含 2 个 P0 锚） | ✅ |
| P3-3 过期注释 | 3 处改正（含 `window.ts` 关于"托盘有打开主窗口菜单项"的错误描述） | ✅ |

**门禁实测**：typecheck ✅ / lint ✅ / check:static 12 项 ✅ / test:scripts 241 ✅ /
test:main 1920 ✅ / test:renderer 1539 ✅ / test:integration 152 ✅ / knip ✅ /
depcruise ✅（1059 模块无环）/ build:win:x64 ✅ / E2E 浏览器 49 ✅ / E2E Electron 18 ✅。

**棘轮处理**：`definitions.ts`（+14 净行）与 `mock-api.ts`（+5 净行）因新增 2 个 IPC 事件而增长。
前者是"完整单一真源"定义表（拆分会破坏该体系），后者把 `app` 域提取为独立函数后**函数体
指标回到基线内**（仅文件净行需显式放宽）。两处均按项目机制 `--update-baseline --force` 显式承认。

### 5.6 验证过程中的两个坑（供后续验证者参考）

**① NSIS 探针必须真静默，否则验证结论失真**

写探针时若声明了 `Page instfiles` / `UninstPage`，**即使传 `/S` 也会弹出向导窗口等待点击**。
我因此吃过一次苦头：以为"已静默执行"就去查注册表，读到的是安装尚未完成的中间态，于是
"宏版探针"与"对照版探针"给出了互相矛盾的结论，一度误判 `!insertmacro customUnInstall`
未生效。正确写法是**不声明任何 Page**（NSIS 无 Page 时 `/S` 才真静默）+ `SilentInstall silent`。

**② NSIS 卸载器异步执行，查状态必须轮询**

卸载器会把自己复制到临时目录后再执行，`/S` 返回时卸载可能尚未开始。用固定 `sleep 4`
读取会落在中间态；应轮询等待（本次实测卸载在 1s 内完成）。

**③ 二进制字符串搜索无法验证 NSIS 脚本内容**

`grep` 安装器二进制找不到 `Software\Microsoft\...\Run` 属**正常现象**（NSIS 压缩字符串）——
连自己写的探针都搜不到。唯一可靠的验证是**实际装一次、查注册表、卸一次、再查**。

**④ Linux CI 无窗口管理器，`isMaximized()` 恒为 false**

首次推送后 CI 在 `ubuntu-latest` 与 `ubuntu-24.04-arm` 上失败：新增的"不带 `--hidden`
且上次为最大化"用例断言 `isMaximized() === true` 稳定失败（重试 3 次全败），而同批次
Windows / macOS 与**两个 P0 锚**（含"最大化 + `--hidden` 仍隐藏"）全绿。

根因是平台限制：CI 用 `xvfb-run` 起虚拟显示且**不启动窗口管理器**（job 日志中无任何
WM 进程），而 X11 的 `maximize()` 通过 WM 的 EWMH 协议生效——无 WM 时窗口无法真正
最大化，`isMaximized()` 恒为 false。**窗口可见性**（该用例的核心意图）在 Linux 上是
通过的。

处置：保留跨平台成立的"窗口必须显示"断言，仅在非 Linux 平台追加最大化态断言并注明依据。
⇒ **教训**：涉及窗口几何/状态（maximize / alwaysOnTop / 位置）的 E2E 断言，在 xvfb 下
都不成立，应限定平台或改用可见性等不依赖 WM 的信号。

### 5.7 附带修复（实施中发现的新缺陷）

**测试日志污染真实用户目录**（本轮引入并当场修掉）：新增 autostart 日志后，跑一次单测
即向 `%APPDATA%/code-agent-desktop/logs/main.log` 写入多条含测试夹具路径的记录。
根因：`initLogger()` 里的测试守卫只在 initLogger 被调用时生效，而单测通常不调用它。
修法：把文件路径重定向前移到**模块加载期**（`utils/logger.ts` 的 `IS_TEST_ENV`），
并**只重定向文件路径、不锁死 console 级别**（后者会让"dev 分支 console=debug"失去可测性）。
验证：跑测试前后比对用户日志 mtime 未变、测试日志落在 `$TEMP/code-agent-test-logs/`。

## 6. 明确不做

| 项 | 理由 |
|---|---|
| 托盘「打开主窗口」菜单项 | spec 28 §6 的菜单形态里本就没有；§10:247 明确"托盘左键只唤回"，且左键已可用。`window.ts:166` 的注释按实际改正，而非加菜单项 |
| `window.ts:246` 丢弃 `trackWindowState` cleanup 返回值 | 与本次缺陷无关（监听随窗口销毁自动失效），另记 |
| macOS 首次最小化引导通知 | darwin 不再走 `hide()`（§4.3），该通知在 mac 上自然不触发，语义正确 |
| 精简桌面不跑 XDG autostart 的情形 | 属环境限制而非实现缺陷；建议在用户文档中如实说明，避免又一种"假成功" |

## 7. 交付拆分

按四个提交/PR 拆（各自可独立审阅、独立回滚）——**§5.5 已按此拆分完成实施**：

1. `fix(window): 静默启动不再被最大化状态击穿 + 新增 showMainWindow 唯一实现` —— §4.0–4.3
2. `fix(autostart): AppImage 用 APPIMAGE 路径 + XDG_CONFIG_HOME + Hidden 语义` —— §4.4–4.5
3. `feat(observability): 自启变更日志 + 诊断包含自启与窗口状态` —— §4.6
4. `feat(tray): 关闭时最小化到托盘 + 两层状态推送同步` —— §4.7；§4.8–4.9 可并入或另起

走 PR 合入 main（ruleset 要求 PR + 5 项必需检查；CI 六平台矩阵见
[29-pipeline-spec.md](./29-pipeline-spec.md)）。合并后这些修复会被 release-please 收进下一个版本，
当前挂着的 Release PR 会随之更新，需要发版时按 [RELEASING.md](../../RELEASING.md) 润色 CHANGELOG
后再合并。
