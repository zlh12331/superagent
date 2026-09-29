# 33 · 系统通知设置（需求 → 设计 → 实施状态）

- **状态**：**已实施**（2026-09-29；c90623c4 → d7b02335 → fa850814 → 178220ff →
  本提交；CP2 双路深读：一路 pass / 一路 V8 硬 fail 已修复转 pass，分歧处置表见 §3.1）
- **判级**：四问两 yes（新增持久化结构 `app_settings`/`notification` 键 + 跨进程副作用：
  渲染层写入门控主进程通知发送）→ 全量流程
- **形态轴**：全链路（存储 + 主进程消费 + UI）——与 resetAll 同形态，不触发 32 号回审

## 1 需求

### 1.1 问题与动机

- **谁**：后台挂回合的用户（最小化到托盘 / 切走窗口的桌面端主力用法，见 28 号托盘 spec）。
- **可观察的问题**：2026-09-04 落地的回合结束通知（`src/main/notification.ts`）是**无开关的
  恒通知**——用户没有任何入口关掉它；多回合密集跑批时每次后台完成都弹一条，被用户视为
  打扰（对齐行业现状：Slack/VS Code 的桌面通知都有用户级开关）。
- **不做的代价**：不想被打扰的用户唯一手段是在 OS 通知中心全局关闭应用通知（连带误伤
  想要的出错提醒），或忍受打扰。

### 1.2 语义边界

**影响清单**：

- `app_settings` 新键 `notification`（值 `{ enabled, onTurnFinished, onTurnFailed }`，
  全布尔）；
- 主进程回合结束通知的发送门控（`notification.ts`）；
- 设置页通用分区新增「系统通知」开关组；
- `SETTING_KEYS` 白名单登记（连带 settings:set / resetAll / 导出导入 / 事件广播自动覆盖）。

**不碰清单**：

- 最小化到托盘的一次性引导通知（`tray.ts` `notifyMinimizedToTray`，键
  `window.hideHintShown` 主进程内部键）——语义是「首次最小化的操作引导」而非回合提醒，
  不纳入本设置域；
- 通知的样式/文案/静音属性（`silent: true` 维持）与点击聚焦行为；
- 前台静默规则（`isAppInForeground` 既有门控不变，设置只在后台场景生效）；
- keychain 凭据、会话历史、IM/MCP 配置、OS 登录项。

### 1.3 验收标准（收尾按 32 号 §5.9② 逐条核对）

- **V1** 默认（无设置/全新安装）行为不变：后台回合结束弹通知。
- **V2** 总开关关 → 任何回合终止（completed/aborted/max-steps/error）一律不弹。
- **V3** 只关「回合完成」→ completed/aborted/max-steps 不弹、error 仍弹。
- **V4** 只关「回合出错」→ error 不弹、其余仍弹。
- **V5** 设置重启后保持（SQLite 真源，启动快照回显）。
- **V6** 恢复默认设置（resetAll）后回落全开。
- **V7** 前台有焦点窗口 → 无论开关状态都不弹（既有规则优先级不受影响）。
- **V8** 导入含 `notification` 键的设置文件 → UI 回显与发送行为同步生效（无需重启）。
- **V9** 总开关关闭时，两个事件开关在 UI 上禁用（值保留，恢复总开关后原值生效）。

### 1.4 影响面盘点

- **进程**：main（notification.ts 消费）+ renderer（store/UI 写入）；shared（键白名单）；
  preload/IPC 契约**零新增**（复用 settings:set/getAll/event:changed，键进枚举即全链生效）。
- **存储**：`app_settings` 表新键 `notification`；无 schema 演进（key-value 表，禁手写 SQL
  的问题不存在）。
- **既有契约**：`SETTING_KEYS` 枚举扩一项 → `SettingKey` 类型、settings:set zod 白名单、
  resetAll 删除集、导出/导入白名单、SettingsChangedPayload 全部自动跟随。

### 1.5 反例点名（设计节逐条处置，禁静默丢弃）

1. **在途写穿透竞态**：toggle 落库前回合恰好结束 → 主进程读到旧值。
2. **损坏/缺失值**：DB 值损坏（非对象/非法字段）时主进程行为未定义则可能崩或恒静默。
3. **无桥（浏览器模式）**：window.api 为 mock，主进程不存在。
4. **导入回声**：导入写库后广播 event:changed，渲染层不能回写（回声循环）。
5. **平台差异**：Linux 无 libnotify 时 `Notification.isSupported()` 为 false。
6. **resetAll 在途写复活**：删除后渲染层在途写把旧值写回（resetAll 已有 flush 防线，
   需核对本域无特殊路径）。

### 1.6 不做清单 + 待拍板项

- 不做：按会话粒度的通知开关、免打扰时段、通知声音开关、通知历史中心、托盘菜单开关项。
- 待拍板项表：

| # | 争议选择 | 建议 | 理由 |
|---|---|---|---|
| D1 | 事件开关粒度：完成/出错两组 vs 单一总开关 | 两组 | 出错通知价值密度显著高于完成通知（用户可只留出错提醒），单开关砍掉了这个高频组合 |
| D2 | 缺失语义：全开（fail-open）vs 全关 | 全开 | 向既有行为兼容——此前恒通知，升级后行为不变；全关会让升级用户「通知凭空消失」 |
| D3 | 通知不可用（isSupported=false）时 UI 是否隐藏开关 | 不隐藏 | 通知能力三平台基本可用（Linux AppImage 自带 libnotify），为一个罕见环境引入条件 UI 不值；设置存在不承诺发送成功 |

## 2 设计

### 2.1 业务逻辑

- **纯函数核心**：`resolveNotificationEvent(reason, settings)` —— 回合终止原因 →
  是否通知的纯判定（reason ∈ {completed, aborted, max-steps} → onTurnFinished；
  error → onTurnFailed；enabled=false 短路全拒）。放 `notification.ts` 导出供测试。
- **读取器**：`readNotificationSettings()`（notification.ts 内部）——读 `readSetting('notification')`，
  对齐 `readCloseAction` 先例：try/catch + 逐字段布尔收窄 + 缺失/损坏字段用默认补齐
  （部分损坏降级到部分默认，不整域丢弃）。**fail-open**：任何异常回落全开（依据 D2），
  且该异常分支补一条 `logger.warn`（罕见事件、非每回合噪音，用户关通知 + DB 行损坏时
  静默回开的场景必须有诊断痕迹——CP2 双路一致建议，采纳）。
- **时机**：TURN_END 事件内**即时读**，不缓存。依据：主进程无法感知渲染层写入时机，
  缓存引入失效广播需求；better-sqlite3 同步单行查询在回合终止路径上开销可忽略
  （file:list 每调用读忽略配置的同款先例）。既有 `Notification.isSupported()` 静默
  跳过门控（反例 5 的发送侧）**保留不动**，设置门控叠加在其之后。
- aborted 归入 onTurnFinished 组（而非 onTurnFailed）：语义是「非错误终止 = 完成组」，
  与通知文案 describeEndReason 的 completed/aborted/max-steps 三者同弹「回合已结束」
  家族一致；error 才是用户必须知道的异常态。
- **失败路径**：读失败 fail-open（弹通知）；发送失败维持既有 catch + logger.warn。
- **复用清单**：零新增 IPC、零新增 handler、零 schema 变更——全部复用 settings 域
  既有链路（resetAll 同款「白名单登记即全链生效」红利）。

### 2.2 数据管理

- 真源：SQLite `app_settings` 键 `notification`；渲染层 store 为内存镜像（写穿透）。
- **缺失语义实证**：主进程消费方仅 notification.ts（本功能新建 readNotificationSettings
  自带兜底）；渲染层 `applySettingsSnapshot` 缺键 → `...DEFAULT_SETTINGS.notification`
  合并回落全开（测试断言）。resetAll 后两端同归默认，不变式「缺失即全开」两端各自成立。
- 写入路径：单键 upsert（`writeSetting`），渲染层 persistSetting fire-and-forget +
  pagehide flush（既有）。
- **反例 1 处置**（在途竞态）：接受秒级窗口——通知是即时性提醒，读到旧值的最坏后果是
  多/少弹一条，非数据损坏；不为它加读写协同复杂度。
- **反例 6 处置**（resetAll 复活）：resetAll handler 删除 SETTING_KEYS 全键，本域无
  特殊路径；渲染层 confirm 后内存同步 `applySettingsSnapshot({})` 复位，在途写均写
  复位后新值，无旧值复活通道（944b39fb 已实证该链路）。
- 导出/导入/resetAll：白名单自动覆盖，零代码。

### 2.3 契约/IPC

零新增。`SETTING_KEYS` 加 `'notification'` 一项（已在工作区完成）：settings:set 的 zod
`z.enum(SETTING_KEYS)`、`SettingKey` 类型、resetAll `deleteSettings(SETTING_KEYS)`、
导入白名单 `new Set(SETTING_KEYS)`、`SettingsChangedPayload` 键枚举全部编译期/运行时
自动跟随。mock-api 的 settings 域是通用 kv localStorage 实现，键透传无需改。
**反例 4 处置**（导入回声）：importSettings 广播 → `applyMainChange('notification', value)`
走「其余对象域按域合并」既有分支，只更新内存不回写（30 号 spec P2-6 防线原样覆盖本域）。

### 2.4 状态管理

- 判定表：UI 开关 → L2 Zustand persistent（settings-store `notification` 域，
  `updateNotification` 部分合并 + 写穿透）；无新增 Query/事件订阅。
- 主进程直写通道不存在（无托盘开关项，依据 1.6），故无新广播需求；导入广播由
  applyMainChange 既有分支消化。
- file-size 棘轮预判：settings-store 现净行 372（check:file-size 实测，+25 预估）余量
  充足；notification.ts 原始 105 行、净行更低（+30 预估）充足；无棘轮放宽需求。

### 2.5 UX 设计

- 入口与信息架构：通用分区（general）「窗口行为」子区（关窗语义 + 开机自启）之后追加
  「系统通知」子区——语义相邻：同属「窗口在后台时应用如何表现」的驻留行为域。
- 反馈闭环：ToggleRow 即时生效（写穿透乐观更新），失败经 persistSetting 既有
  reportError 链路（设置写入无独立 toast——与 theme/window 等同域一致，不搞双标）。
- i18n 双语：`settings.notificationTitle`（子区标题）/ `notificationLabel`（总开关）/
  `notificationDesc` / `notificationFinishedLabel` / `notificationFinishedDesc` /
  `notificationFailedLabel` / `notificationFailedDesc`，zh-CN 与 en 同批。
- **反例 3 处置**（无桥）：mock 透传，浏览器模式 UI 可用、行为（通知）本就不存在，
  无需特判。

### 2.6 UI 设计

- 组件：`sections/notification-section.tsx` 独立小组件（对齐 telemetry-section 拆分
  先例），内部 3 个 `ToggleRow`（settings-controls 现成控件，无裸色、无新 CSS）；
  GeneralSection 引入。事件开关 `disabled={!enabled}`（V9），描述文案说明原因。
- 图标：`Bell`（lucide），对齐**落点相邻分区**图标惯例（size-3.5 / strokeWidth 1.5；
  CP2 指出 size-4 系文档口径错误，以 general-section 现有图标为准）。
- 动效：无新增（开关为既有 Switch，无自定义动画 → check:animations 无新增引用）。

### 2.7 测试与安全

- **主进程**（新 `src/main/notification.test.ts`，红灯先行）：mock electron
  （BrowserWindow/Notification，对齐 window-show.test.ts 的字符串键手法）+ mock
  settings-pref.readSetting 注入设置值。断言矩阵：V1（undefined→completed 弹）/
  V2（enabled=false 全不弹）/ V3 / V4 / V7（前台不弹）/ 损坏值（非对象→弹，fail-open）/
  部分损坏（enabled 合法 + onTurnFinished 损坏→按默认 true）。不发通知的路径断言
  `new Notification` 未被调用。
- **store**（settings-store.test.ts 追加）：① 快照缺键回落合并（V5 回显半 + V6 渲染半）；
  ② 部分字段合并；③ 写穿透 key 断言（V5 写半）；④ **applyMainChange('notification', value)
  按域合并且不触发 persistSetting（不回写）**——闭合 V8 导入即时生效回显半 +
  反例 4 回归防护（CP2 第二路硬 fail 修复项）。
- **组件**（notification-section.test.tsx）：断言 store 实质状态——总开关关 → 事件开关
  disabled（V9）；toggle 总开关 → updateNotification 写穿透调用与 store 状态。
- 安全：无凭据、无危险操作；输入校验靠 readNotificationSettings 字段收窄
  （DB 值不可信原则，同 readCloseAction）。

### 2.8 发布与复盘

- 成功指标：无遥测明细（本地优先），复盘锚 = 用户反馈 + 诊断包日志
  （通知发送/抑制均有 logger 痕迹可选，本功能不加新日志——门控判断每回合打日志是噪音）。
- 不进 experimental：开关组是纯门控，无观察期必要。

### 2.9 多入口盘点

全量入口清单：① 设置页通用分区（本功能新增，唯一写入口）；② 导入设置文件（间接写，
经白名单+广播）；③ resetAll（删键回默认）。**托盘菜单无通知开关项**（tray.ts 实测仅
关窗行为勾选 + 自启 + 更新 + 最近会话），不新增——保持主进程零直写，无双份状态风险。

## 3 状态

### 3.1 CP2 双路深读结论（2026-09-29）

- 第一路：**pass**——九方向全过、六反例全处置、D1-D3 成立；5 项分歧均为口径级。
- 第二路：**fail ×1**——§2.7 缺 V8 断言计划；其余八方向 pass、六反例全处置。
- **分歧处置表**（32 号 §2③：不裁决、呈拍板；自主模式下按建议列采纳并回写）：

| # | 分歧 | 处置 | 落点 |
|---|---|---|---|
| 1 | 状态头预写「CP2 通过→已实施」与代码现状不符 | 采纳：状态头如实化 + 本披露节 | 文档头 / §3.1 |
| 2 | 「105 净行」实为原始行数，口径错误 | 采纳修正（结论不变，余量更足） | §2.4 数字作废，以 check:file-size 实测为准 |
| 3 | fail-open 读失败分支建议补 logger.warn | 采纳：罕见异常分支补 warn，非每回合噪音 | §2.1 |
| 4 | 图标 size-4 vs 落点 size-3.5 | 采纳：以相邻分区为准 | §2.6 |
| 5 | V8 缺断言计划（硬 fail） | 采纳：store 测试补 applyMainChange 合并不回写断言 | §2.7 |
| 6 | V5/V6/V9 组合覆盖未显式标号 | 采纳：§2.7 store 测试清单逐条标 V 号 | §2.7 |
| 7 | 反例 5 发送侧门控未被 §2.1 显式确认保留 | 采纳：补「isSupported 门控保留不动」 | §2.1 |
| 8 | aborted 归组未单列依据 | 采纳：补语义依据（非错误终止=完成组） | §2.1 |
| 9 | CP2 收口前地基代码已入工作区（时序张力） | 如实披露；地基=白名单登记+纯数据域，风险低；主进程门控与 UI 等本节结论后才动 | 本节 ⚠️ |
| 10 | mock/importSettings/tray 三处前提两路均未独立复核 | 实施期兜底：mock kv 透传有 dev 实证、importSettings 广播代码已在 handler 实读核实（settings.handler.ts:116-122）、tray.ts 通知项缺失已 grep 实证 | §2.3 / §2.9 |

### 3.2 实施记录与验收核对

**提交链**（每个独立可编译可回退）：

1. `c90623c4` 地基：SETTING_KEYS 登记 + settings-store notification 域 + store 测试
   + 33 号 spec 初稿；
2. `d7b02335` 主进程门控：readNotificationSettings + shouldNotifyTurnEnd +
   notification.test.ts 七断言矩阵；
3. `fa850814` 设置 UI：NotificationSection 三开关组 + GeneralSection 挂载 + i18n 七键
   双语 + 组件四断言；
4. `178220ff` 契约测试同步：shared 白名单契约测试补 notification 键
   （c90623c4 漏改，全量测试链红灯暴露——契约测试守卫职责生效）。

**V1-V9 逐条核对**（32 号 §5.9②；测试名对照 §2.7）：

| V | 结论 | 证据 |
|---|---|---|
| V1 | ✅ | 主进程「V1 无设置 undefined → completed 照常弹」 |
| V2 | ✅ | 主进程「V2 总开关关 → 四种终止一律不弹」（断言构造次数 0） |
| V3 | ✅ | 主进程「V3 只关完成组 → 三 reason 不弹、error 仍弹」 |
| V4 | ✅ | 主进程「V4 只关出错组 → error 不弹、completed 仍弹」 |
| V5 | ✅ | SQLite 真源 + store 写穿透 key 断言（写半）+ 快照部分字段合并（回显半）；重启本身非单测可达，机制两半均有测试 |
| V6 | ✅ | resetAll 走 `deleteSettings(SETTING_KEYS)` 白名单自动覆盖（零代码）+ V1 undefined 用例（主进程）+ 快照缺键回落用例（渲染）组合覆盖 |
| V7 | ✅ | 主进程「V7 前台有焦点 → 设置全开也不弹」 |
| V8 | ✅ | store「applyMainChange 按域合并不回写」（回显半，CP2 第二路 fail 修复项）+ 主进程即时读无缓存（V1-V4 测试构造性证明） |
| V9 | ✅ | 组件「总开关关 → 事件开关 disabled + 引导文案」+「值保留恢复生效」 |

**门禁实录**：typecheck / lint / check:static 15 项全过（棘轮零放宽）/ 全量测试链
shared 81 + main 2059 + renderer 1782 + integration 152 + scripts 364 全绿。

### 3.3 复盘锚与 32 号流程回审素材（全链路形态第二样本）

- 本功能为 32 号「全链路」形态在 resetAll 之后的第二个样本。实测补充（供 32 号
  §7 回审采信）：① §3.5 反例点名 → §2 处置 → CP2 逐条核对闭环运转有效，拦下
  V8 断言缺失这一实质性缺口；② CP2 双路深读的「特别职责分派」（第二路专核
  V×测试映射）比双路同构全量更有效，建议沿用；③ 实施期两枚红灯（shared 契约
  测试、既有 import 缺失）均为连带遗漏而非设计缺陷——定义表红利域的连带测试
  面小而固定，棘轮预演 §5.5 三门本次零触发。
- 复盘双锚（§4.8）：用户反馈 + 诊断包日志（读失败 warn / 发送失败 warn 均随
  诊断包导出）；不进 experimental（纯门控无采用率观察需求）。
