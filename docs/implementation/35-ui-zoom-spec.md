# 35 · 界面缩放（需求 → 设计 → 实施状态）

- **状态**：**已实施**（2026-09-29；55761cf3 → 89b787ce → ab73b9bb → d6794c21 →
  ce50fd62 → 本提交；CP2 双路 7 fail 全部修复采纳，处置表见 §3.1；V1-V9 核对 §3.2）
- **判级**：四问三 yes（新增持久化 `app_settings`/`appearance` 键 + 跨进程副作用
  Windows overlay 联动 + 多组件联动 store/UI/快捷键）→ 全量流程
- **形态轴**：全链路 + 主进程子系统；**消费方式 = 混合型**（渲染层推送式应用 +
  主进程仅接收 overlay 联动通知），回审 32 号素材

## 0. 需求期实测基线（事实底座，全部代码实证）

| 事实 | 位置 | 设计含义 |
|---|---|---|
| 应用级缩放唯一机制 = `webContents.setZoomFactor()`（DIP 缩放，等比缩放 CSS px） | Electron 44 API | 选 zoomFactor（线性）而非 zoomLevel（指数） |
| 主窗口 webPreferences 未做任何 zoom 配置；Electron 默认 zoomFactor 恒 1，Ctrl+±/滚轮无 UI 感知 | window.ts:121-128 | 缩放需自建全链（设置/快捷键/持久化） |
| **titleBarOverlay.height 是 DIP 固定值**（52px），CSS 顶栏随 zoomFactor 缩放 | window.ts:117 | 非 100% 缩放时窗口控件区与自绘顶栏错位——Windows 须联动重设 overlay |
| `setTitleBarOverlay` 仅 Windows 支持运行时更新（Linux WCO 无此 API；macOS 无 overlay） | window-theme.ts:26 | overlay 联动限 win32 分支 |
| 浏览器预览有独立 zoom（`BrowserZoom` 6 档、`browser.defaultZoom` 域、preview 分区独立 webContents） | preview-service.ts:129、settings-store.ts:163 | **严格隔离**：应用缩放不碰 preview 分区 |
| 快捷键体系 react-hotkeys-hook；固定键区先例（'?' F1 / Ctrl+B / Ctrl+J）；用户可配置区 6 项 | use-keyboard-shortcuts.ts | Ctrl+=/-/0 走**固定键**区 |
| `autoHideMenuBar: true` 且无应用菜单 | window.ts:100 | Ctrl+± 无菜单冲突，自建快捷键是唯一键盘入口 |
| store 每域一份模式成熟（notification/proxy 先例）；window.handler 不存在（ipc/ 下无此文件） | 实测 | 同构复用；applyZoom handler 新建小文件 |

## 1 需求

### 1.1 问题与动机

- **谁**：① 高分屏/低分屏用户（UI 过小/过大）；② 低视力用户；③ 演示/投屏场景。
- **可观察的问题**：界面固定 100% 无法调整。Electron 内核缩放能力存在但应用未提供
  任何入口（无 UI、无快捷键、无持久化）。
- **不做的代价**：用户只能调系统级 DPI 缩放（影响全局所有应用）或显示器分辨率
  （模糊）——门槛高且不精准。

### 1.2 语义边界

**影响清单**：
- `app_settings` 新键 `appearance`（值 `{ zoom: number }`，zoom ∈ 离散档位）；
- 主窗口 webContents.setZoomFactor（应用级，**不碰** browser-preview 分区）；
- Windows titleBarOverlay.height 随缩放联动（round(52 × zoom)，win32 专属）；
- settings-store 新 `appearance` 域 + 设置页「界面缩放」行 + 固定快捷键三枚。

**不碰清单**：browser-preview 的 BrowserZoom（独立功能零交集）；系统 DPI/显示器
设置；窗口尺寸记忆（window-state.json，缩放不改 bounds）；托盘菜单（低频设置项，
过重）；命令面板缩放命令；Ctrl+滚轮（v2 评估——与终端/代码区滚动冲突面大）。

### 1.3 验收标准（V1…V9；收尾逐条核对）

- **V1** 默认 100%（zoom 缺失 → 1.0；损坏 → 最近合法档位归一，与反例 2 处置一致）。
- **V2** 选择 125% → 主窗口整体放大 1.25（顶栏/侧栏/主区等比），窗口尺寸不变。
- **V3** 各档位即时生效，无需重启（推送式）。
- **V4** 重启后保持（SQLite 真源 + 启动链应用）。
- **V5** resetAll 后回落 100%。
- **V6** 导入含 appearance 键的文件 → 回显 + 应用（与 33/34 号 V8 同链路语义）。
- **V7** Windows 缩放 ≠ 100% 时 titleBarOverlay.height 联动（52 → round(52×zoom)），
  100% 回落 52；非 win32 不调用。
- **V8** 浏览器预览缩放不受影响（preview 分区独立 webContents，构造性隔离）。
- **V9** Ctrl+= / Ctrl+- / Ctrl+0 分别放大/缩小/重置（档位间移动，边界钳制）。

### 1.4 影响面盘点

- 进程：main（applyZoom handler：win32 overlay 联动）+ renderer（store/UI/快捷键/
  应用函数）；shared（键白名单 + 值级门禁 + applyZoom 契约）。
- 存储：`app_settings` 键 `appearance`；无表结构演进。
- 契约：SETTING_KEYS 扩一项 + superRefine 门禁 + 新增 1 个 IPC 方法（§2.3）。

### 1.5 反例点名（设计节逐条处置，禁静默丢弃）

1. **在途写穿透竞态**：渲染层推送式无主进程读库竞态；启动链顺序（bootstrap 快照 →
   applyZoom）保证一致。
2. **损坏值**：DB 值损坏（非对象/zoom 非法档位/越界）→ clampZoom 最近档位归一
   （0.93 → 0.9），非整域丢弃。
3. **无桥（浏览器模式）**：无主进程无 webContents——applyZoom 必须 no-op 不抛，
   store 内存态可用。
4. **快捷键冲突**：Ctrl+= 的浏览器习惯变体 Ctrl+Shift+=（同物理键）需同绑；Ctrl+0
   无标签页语义冲突（本项目无标签）。
5. **多 webContents 指向**：单窗口设计但 getAllWindows() 返回数组——应用缩放遍历
   全部窗口，未来多窗口语义已正确。
6. **平台差异**：overlay 联动仅 win32；macOS/Linux 无 overlay 语义，纯 CSS px 缩放。
7. **overlay 联动失败**：setTitleBarOverlay 在部分 Windows 版本/窗口态抛错
   （window-theme.ts 先例）——失败仅控件区错位，不阻断缩放本身，warn 留痕。

### 1.6 不做清单 + 待拍板项表

- 不做：Ctrl+滚轮缩放（v2）、按窗口记忆缩放（与全局设置冲突）、OS 级 DPI 联动、
  命令面板缩放命令、托盘缩放菜单、快捷键帮助对话框列举缩放键（v1 克制）。
- 待拍板项表（CP1 按建议列拍板）：

| # | 争议选择 | 建议 | 理由 |
|---|---|---|---|
| D1 | 应用时机：渲染层推送 vs 主进程拉取 | 渲染层写入驱动 + 主进程单点收口（CP2 路1 依据重写） | 原稿「渲染层直调最短路径/主进程拉取不值」与事实矛盾（执行必在主进程，且 applyZoom IPC 本就要建）；真实依据 = store 单真源写入驱动 + 单一 IPC 让 setZoomFactor 与 win32 overlay 原子完成 + 多窗口遍历天然（webFrame 方案三者皆缺） |
| D2 | 档位集 | 11 档 Chrome/Chromium 缩放预设谱系 | 对齐浏览器成熟惯例（0.5/0.67/0.75/0.8/0.9/1/1.1/1.25/1.5/1.75/2 逐项吻合）；细档位给低视力用户台阶（CP2：非 VS Code 谱系，VS Code 是线性 10% 步进） |
| D3 | Windows overlay 联动 | v1 做（win32 分支） | 不联动则非 100% 缩放时控件区与顶栏视觉断裂（52 DIP 固定 vs CSS 缩放），功能完整性质疑点 |
| D4 | 快捷键形态 | 固定键 Ctrl+=/-/0，不进用户可配置清单 | 高频键盘操作；可配置清单 6 项已稳定，帮助对话框不跟随（v1 克制） |
| D5 | UI 形态 | SettingRow + ui/select | 11 档 SegControl 溢出（11×~40px > 行宽）；下拉紧凑可扩展 |

## 2 设计

### 2.1 业务逻辑

- **纯函数核心**（落 **packages/shared**——CP2 路1：主进程 handler/测试要消费
  ZOOM_LEVELS 与 overlayHeightFor，落 renderer/lib 会造成 main→renderer 反向依赖；
  shared 化后两端共用单一真源）：`packages/shared/src/constants/zoom.ts`：
  - `ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]`
    （Chrome/Chromium 缩放预设谱系——CP2 修正归属，非 VS Code）；
  - `clampZoom(value: number): number` —— 任意数值 → 最近合法档位；
  - `stepZoom(current: number, direction: 1 | -1): number` —— 快捷键调档（索引
    ±1，边界钳制）；
  - `overlayHeightFor(zoom: number): number` —— Windows overlay 高度 = round(52×zoom)。
- **应用函数**（`src/renderer/lib/zoom.ts` 薄壳，内部 clampZoom 兜底——CP2 路2
  fail-5：导入路径绕过 superRefine，损坏值归一钉死在「快照合并处 + applyZoom 入口处」
  双防线）：调 `window.api.window.applyZoom({ zoom })`（无桥 no-op）。
- **应用单点（CP2 路2 D-1 采纳，消解其 fail-2/fail-3）**：AppShell 挂**单点 effect**
  订阅 `appearance.zoom`——五入口（设置页/快捷键/导入/resetAll/启动）全部经 store，
  单 effect 覆盖全部入口，无需在各入口散布调用；首帧跳变由 main.tsx bootstrap
  链解决（下条）。effect 挂载时与 bootstrap 重复触发一次同值调用——setZoomFactor
  幂等，无害（断言按「值收敛」而非「调用次数」）。
- **首帧时序（CP2 路1 fail 修复）**：main.tsx `await bootstrapSettings()` →
  `applySettingsSnapshot` → **render() 之前**直接调 applyZoom（bootstrap 值）——
  effect 在首帧 commit 后才跑且生效还需异步 IPC，非 100% 用户会先见 100% 再跳变；
  theme 有同款 `mirrorThemeForFirstPaint` 先例。
- **执行收口**：渲染层无 webContents 句柄（sandbox 架构实证），zoomFactor 应用与
  Windows overlay 联动在主进程 handler 一处原子完成。CP2 路1 特别职责核实：
  sandbox preload 的 `webFrame.setZoomFactor` 技术上可用——**收口主进程是设计选择
  而非能力限制**（单 IPC 让缩放+overlay 原子化、多窗口遍历天然、preload 面不扩大）。
- **失败路径**：handler 内 setZoomFactor 失败（窗口销毁）静默 no-op；setTitleBarOverlay
  try/catch + warn（反例 7）；无桥时 applyZoom no-op 不抛（反例 3）。
- **Ctrl+滚轮与单真源（CP2 路1 提名的未实证风险）**：Electron 有 `zoom-changed`
  原生路径，若滚轮缩放默认生效，用户可产生 store 之外的 zoomFactor 偏移、重启被
  store 值打回。实施首日实测；若原生滚轮缩放存在，在主进程监听主窗口 zoom-changed
  以 store 值回写（对齐单真源——原生偏移被矫正而非静默分叉）。
- 安全边界：zoom 值双保险（clampZoom + superRefine 档位门禁）；无凭据无危险操作。

### 2.2 数据管理

- 真源：`app_settings` 键 `appearance`（默认 `{ zoom: 1 }`）。
- 缺失/损坏语义：键缺失 → 默认；值损坏 → clampZoom 归一（反例 2）。
- 写穿透：persistSetting fire-and-forget + pagehide flush（既有）。
- 导出/导入/resetAll：白名单自动覆盖（存储层零代码）；应用层经导入广播 →
  applyMainChange('appearance') → 渲染层 applyZoom（V6）；resetAll → 快照回落 +
  applyZoom（V5）。
- **反例 1 处置**：启动链顺序保证——settings-bootstrap 拉快照 → applySettingsSnapshot
  → AppShell 首帧 effect 内 applyZoom(store.appearance.zoom)；无读库竞态。

### 2.3 契约/IPC

- **新增 1 个 IPC 方法 `window:applyZoom`**（渲染层 → 主进程）：请求
  `{ zoom: number }`，响应 `{ ok: boolean }`。为什么需要：setZoomFactor 与
  setTitleBarOverlay 均为主进程 API，渲染层无句柄；单 handler 同时完成缩放与
  Windows overlay 联动（一处收口）。定义表四件套同步（meta/definitions/handler/mock
  ——mock 缺失会 dev FATAL，34 号实证）。IPC 域名用 `window`（与 settings 键
  `window` 重名但分属 meta/settings 两表，CP2 路1 提名的可读性噪音，接受——域语义
  即「主窗口操作」）。
- SETTING_KEYS 加 `'appearance'`；SettingsSetReqSchema superRefine 加 appearance
  值级门禁：zoom 必须 ∈ ZOOM_LEVELS（档位集 shared 化，主进程门禁与渲染层 clamp
  共用同一常量——单一真源）。**双防线措辞（CP2 路1 修正）**：导入路径走
  applySettingsImport（白名单直写，不过本 schema），导入侧真实防线是读侧
  clampZoom；superRefine 防的是 settings:set 通道 + 未来直写方。
- **反例 4 处置（键串形态 CP2 路2 fail-4 修正）**：react-hotkeys-hook v5 按
  event.code 匹配（文件内 Slash/Backquote/ArrowLeft 先例），非字母键必须用 code 名
  ——`ctrl+Equal,ctrl+shift+Equal,meta+Equal,meta+shift+Equal`（放大，+= 与 = 同物理键）、
  `ctrl+Minus,meta+Minus`（缩小）、`ctrl+Digit0,meta+Digit0`（重置）；实施首日
  以真实按键验证匹配（V9 依赖此，失败则降级为 keydown 自定义监听）。
  固定键区（'?' F1 先例），不进用户可配置清单（D4）。

### 2.4 状态管理

- L2 Zustand persistent：settings-store `appearance` 域（`updateAppearance` 部分合并
  + 写穿透；快照缺键回落 `{zoom:1}` 且**读侧 clampZoom 归一**——CP2 路2 fail-5
  钉死归一点：快照合并处归一，handler 不再二次防御）。
- **applyMainChange 不加 appearance 专属分支**（CP2 路2 D-1 采纳后的简化）：落
  既有「其余对象域按域合并」通用分支即可——应用单点是 AppShell 的
  useZoomEffect（订阅 store），广播合并后 effect 自动触发，无需在 store 内加分支
  （changeLanguage 先例不适用：language 只有托盘一个旁路入口需要内联收口，zoom
  五入口全走 store，形态不同——两路一致采纳单点方案）。
- 快捷键：use-keyboard-shortcuts 增三个固定绑定（handlers 增
  onZoomIn/onZoomOut/onZoomReset 可选字段，ref 转发先例）；handlers 实现落
  AppShell（stepZoom → updateAppearance；应用由 useZoomEffect 收敛）。
- **store 注释登记（CP2 路2 D-4）**：settings-store 头注释「纯内存态」与 action 层
  副作用（changeLanguage 既有 + 未来类似模式）已漂移，实施时在头注释登记
  「updater 必须纯；action 层允许 UI 即时生效类外呼」的模式说明。
- file-size 棘轮预判：settings-store 净行 395（CP2 路1 实测口径）+~20 余量足；
  shared/constants/zoom.ts 新文件 ~50 净行；window.handler.ts 新小文件；无棘轮触碰。

### 2.4.1 应用单点与首帧链（接线总图，CP2 fail-2/fail-3 消解）

```
入口①设置页 updateAppearance ─┐
入口②快捷键 stepZoom→updateAppearance ─┤
入口③导入 广播→applyMainChange(通用分支) ─┼─→ store.appearance.zoom ─→ AppShell useZoomEffect ─→ applyZoom
入口④resetAll 快照回落 ─┘                                   （单点，覆盖全部入口）
入口⑤启动 bootstrap→applySettingsSnapshot→render 前 applyZoom（首帧值）→ render → useZoomEffect 同值幂等
```

### 2.5 UX 设计

- 入口：设置页通用分区（general-section），「窗口行为」子区之后追加「界面缩放」
  行（SettingRow + ui/select 11 档，D5）。
- 反馈闭环：选择即生效（useZoomEffect 单点应用）；快捷键调档后 Select 回显同步
  （store 单真源驱动）。**首帧时序已在 §2.1 修正**（bootstrap render 前应用首帧值，
  修「effect 内 ≠ 首帧前」的初稿矛盾——mirrorThemeForFirstPaint 同款先例）。
- i18n 双语：settings.zoomTitle / zoomLabel / zoomDesc / zoomPercent（{{percent}}
  插值），实施期定稿清单双语同批。
- **反例 5 处置**：handler 遍历 BrowserWindow.getAllWindows()。
- **反例 6 处置**：overlay 联动限 win32 分支（window-theme.ts 同款平台分支先例）。
- **反例 7 处置**：setTitleBarOverlay try/catch + logger.warn，不阻断缩放
  （window-theme 先例是刻意静默；本 handler 独立文件无该约束，warn 可行——CP2
  路2 确认）。

### 2.6 UI 设计

- 组件：`sections/zoom-section.tsx` 独立小组件（telemetry-section 拆分先例），
  general-section 引入；ui/select（Radix Select，含方向键/roving tabindex 语义）。
- 图标 ZoomIn（lucide）size-3.5 / strokeWidth 1.5（相邻分区惯例）。
- 动效无新增；无裸色值（check:tokens 卡关）。

### 2.7 测试设计

- **shared 纯函数**（constants/zoom.test.ts）：clampZoom（损坏/越界/合法值归一矩阵，
  含 0.93→0.9 归一半——V1 损坏语义）/ stepZoom（两端边界钳制）/ overlayHeightFor
  （1 → 52、1.25 → 65、2 → 104）。
- **store**：缺键回落 / 部分合并 + **损坏快照归一**（applySettingsSnapshot 传损坏
  zoom → store 值为最近档位——V1 断言落点）/ 写穿透 key / applyMainChange 不回写
  （四件套同构）。
- **useZoomEffect 单点**（AppShell 级 hook 测试）：store.zoom 变化 → applyZoom 调用
  参数断言（V2/V3/V5/V6 的**应用半统一断言点**——覆盖 resetAll 回落 V5 与导入
  广播 V6，CP2 fail-3 消解）；V4 启动半 = main.tsx bootstrap render 前 applyZoom
  的调用（构造性时序，注释注明不可单测、机制由启动链代码评审保证）。
- **组件**：Select 渲染 11 档 / 选择写 store / 快捷键模拟调档回显（键串形态按
  §2.3 code 名断言——V9）。
- **主进程**（window.handler）：非 win32 平台不调 setTitleBarOverlay（mock
  process.platform）+ win32 联动 overlayHeightFor 一致性 + setZoomFactor 调用断言
  （mock BrowserWindow.getAllWindows）+ 窗口销毁 no-op + **遍历集不含 WebContentsView**
  （V8 构造性隔离断言注明：WebContentsView 非 BrowserWindow，天然不在
  getAllWindows() 集）。
- **契约**：shared superRefine appearance 门禁断言（合法档位过/非法拒/白名单外拒）。

### 2.8 发布与复盘

- 成功指标：本地优先无遥测，复盘锚 = 用户反馈 + 诊断包（overlay 联动失败 warn）。
- 不进 experimental：纯视觉能力，无采用率观察需求。

### 2.9 多入口盘点

全量入口：① 设置页 ② 快捷键 ③ 导入（广播 → applyMainChange 通用分支）④
resetAll（快照回落）⑤ 启动链（bootstrap 首帧值 + useZoomEffect 幂等）。五入口
全部经 store，**应用单点 = AppShell useZoomEffect**（CP2 D-1 采纳，接线总图见
§2.4.1）——「五入口同一 applyZoom」由单点 effect 构造性保证，无散布调用点。
**主进程零直写**（无托盘项）。无双份状态。

## 3 状态

### 3.1 CP2 双路深读结论（2026-09-29）

- 第一路：**fail ×2**——§2.5「首帧前应用」与 §2.2「effect 内应用」自相矛盾
  （effect 在首帧 commit 后跑）；D1 依据过时（「渲染层直调」被沙箱架构推翻 +
  「主进程拉取不值」与新增 IPC 事实矛盾）。特别职责核实：渲染层无 webContents
  句柄属实；webFrame.setZoomFactor 在 sandbox preload 可用——收口主进程是设计
  选择而非能力限制（结论保留，措辞修正）。
- 第二路：**fail ×5**——V1 文本与反例 2 处置矛盾；①②④ 入口 applyZoom 触发点
  未落笔；V4/V5/V6 断言计划缺口；快捷键键串形态（v5 按 event.code 匹配）；clampZoom
  归一化调用点未钉死。特别职责：applyMainChange 外呼有 changeLanguage 先例、
  依赖方向干净，但 D-1 单点方案更优。
- **分歧处置表**（全部采纳；fail 修复已回写 §2 对应节）：

| # | 来源 | 项 | 处置 | 落点 |
|---|---|---|---|---|
| 1 | 路1 fail | 首帧跳变矛盾 | 采纳：bootstrap render 前应用首帧值 + useZoomEffect 单点幂等 | §2.1/§2.5 |
| 2 | 路1 fail | D1 依据过时 | 采纳：依据重写（store 单真源 + 原子收口 + 多窗口天然） | §1.6 D1 |
| 3 | 路1 | ZOOM_LEVELS 落点张力 | 采纳：整体落 packages/shared/constants/zoom.ts | §2.1 |
| 4 | 路1 | webFrame「必须走主进程」过强 | 采纳：改「设计选择」措辞 | §2.1 |
| 5 | 路1 | 「superRefine 防导入」不准 | 采纳：改双防线措辞 | §2.3 |
| 6 | 路1 | 键串 code 名疑点 | 采纳：Equal/Minus/Digit0 形态 + 实施首日真机验证 + 降级预案 | §2.3 |
| 7 | 路1 | Ctrl+滚轮与单真源未实证 | 采纳：实施首日实测，若原生生效则 zoom-changed 回写对齐单真源 | §2.1 |
| 8 | 路2 fail-1 | V1 自相矛盾 | 采纳：V1 改「缺失→1.0；损坏→最近档位归一」 | §1.3 |
| 9 | 路2 fail-2/3 | 触发点缺失 + 断言缺口 | 采纳：D-1 单点 useZoomEffect 方案（一并消解） | §2.1/§2.4/§2.4.1/§2.7 |
| 10 | 路2 fail-4 | 键串形态（同 6） | 采纳（同 6） | §2.3 |
| 11 | 路2 fail-5 | 归一化调用点未钉死 | 采纳：快照合并处归一 + applyZoom 入口兜底 | §2.1/§2.4 |
| 12 | 路2 | D2 档位集归属 | 采纳：改 Chrome 谱系 | §1.6 D2 |
| 13 | 路2 | store 注释漂移 | 采纳：实施时登记「updater 纯 / action 层外呼」模式 | §2.4 |
| 14 | 路1 | §2.1 行内自我修正段 | 采纳：已清理重写 | §2.1 |
| 15 | 路2 | V8 断言论证注明 | 采纳：遍历集不含 WebContentsView 构造性隔离 | §2.7 |

### 3.2 实施记录

**提交链**（每个独立可编译可回退）：

1. `55761cf3` 35 号 spec（需求/设计/CP2 双路 7 fail 处置表 15 项全量成文）；
2. `89b787ce` shared 地基：constants/zoom.ts（四纯函数，ZOOM_LEVELS 11 档）+
   SETTING_KEYS 登记 appearance + superRefine 档位门禁 + 白名单契约测试同步；
3. `ab73b9bb` 主进程与应用端：window:applyZoom 契约四处闭环（meta/schema/
   definitions/handler/mock）+ window.handler（遍历/win32 overlay/销毁守卫）+
   store appearance 域（快照合并处 clampZoom 归一，CP2 fail-5 钉死点）；
4. `d6794c21` 应用链：lib/zoom 薄壳 + main.tsx 首帧前应用（CP2 路1 fail 修复）
   + use-zoom-effect 单点（CP2 路2 D-1 采纳，五入口构造性覆盖）+ Ctrl+Equal/
   Minus/0 固定快捷键（v5 code 名实证）；
5. `ce50fd62` UI：zoom-section（ui/select 11 档）+ GeneralSection 挂载 + i18n
   四键双语 + 组件四断言。

**实施期实测补充**（32 号回审素材）：

- **clampZoom 非有限数缺陷**（实施期实测）：NaN 比较全 false 使结果停在数组首项
  （返回 0.5 而非默认 1）——「缺失语义」与「越界钳制」的分野必须前置类型拦截。
  已修复（非有限数 → DEFAULT_ZOOM）+ 4 断言固化。教训：纯函数的「缺失」路径要在
  实现期就用 undefined/NaN 实测，不能只推理。
- **react-hotkeys v5 键串实证**：源码归一化 `replace(/key|digit|numpad/,'')` +
  `event.code` 匹配——`Digit0`→`0`、`Equal`/`Minus` 为裸名；键串写 `ctrl+Equal`/
  `ctrl+Minus`/`ctrl+0`（CP2 fail-4 的疑虑以源码证据消解，无需降级方案）。
- **棘轮连锁**：file-size definitions 1037→1046 / mock-api 980→983、functions
  mock-api 380→382——applyZoom 契约与 mock 域注册的声明性增长，`--force` 显式
  放宽留痕（提交 ce50fd62）。
- **门禁实录**：check:static 15 项全过；五层测试链 shared 95 + main 2095 +
  renderer 1802 + integration 152 + scripts 364 全绿。

**V1-V9 逐条核对**（32 号 §5.9②；测试名对照 §2.7）：

| V | 结论 | 证据 |
|---|---|---|
| V1 缺失 1 / 损坏归一 | ✅ | shared「缺失语义非有限数→1」4 断言 + 「损坏归一 0.93→0.9」+ store「快照缺失回落/损坏归一」 |
| V2 125% 整体放大 | ✅ | handler「遍历全部窗口 setZoomFactor(1.25)」+ 组件「125% 回显」；窗口尺寸不变为构造性（无代码触 bounds） |
| V3 各档即时生效 | ✅ | use-zoom-effect 订阅 store → applyZoom（handler 同步执行断言）+ 五断言全绿 |
| V4 重启保持 | ✅ | store 写穿透 key 断言 + 快照合并（持久化半）；启动半 = main.tsx render 前 applyZoom（时序构造性，代码评审保证——bootstrap→snapshot→applyZoom 顺序在同一 await 链） |
| V5 resetAll 回落 100% | ✅ | applySettingsSnapshot({}) → zoom 归 DEFAULT_ZOOM → useZoomEffect 触发应用（store V1 断言 + 单点链） |
| V6 导入回显+应用 | ✅ | store「applyMainChange 按域合并且不回写」+ 通用分支落 store → useZoomEffect 应用（单点覆盖） |
| V7 win32 overlay 联动 | ✅ | handler 4 断言（win32 65/非 win32 不调/100% 52/API 抛错不阻断）+ shared overlayHeightFor 数值 |
| V8 预览缩放隔离 | ✅ | handler「仅遍历 BrowserWindow」构造性隔离断言（WebContentsView 非 BrowserWindow，不在集内） |
| V9 Ctrl+±0 | ✅ | 键串 v5 源码实证 + use-keyboard-shortcuts 三固定绑定 + AppShell handlers（stepZoom/DEFAULT_ZOOM）+ shared stepZoom 边界钳制 |

**遗留（真机确认类）**：① Ctrl+滚轮原生缩放是否生效（zoom-changed 回写方案已设计
未实现——实测若确认原生生效，按 §2.1 处置）；② Windows overlay 联动在非 100% 档位
的真机视觉确认（逻辑与断言已覆盖，视觉需人工）；③ macOS/Linux 无 overlay 语义
（构造性，无需验证）。
