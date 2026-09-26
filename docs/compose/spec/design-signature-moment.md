---
feature: design-signature-moment
status: designed
updated: 2026-09-26
branch: (pending)
commits:
---

# 问题 4 · 签名时刻（可记忆的产品瞬间）

> 系列：一个问题 · 一份方案 · 一个文档，路径 `docs/compose/spec/`。
> 前置：`design-identity.md`（P1 身份/quiet）→ 本文件只加**节奏与叙事**，禁止回退成渐变发光。
>
> **核实方式**（2026-09-26）：通读 `home.tsx`、`tool-call-view.tsx`、`file-change-card.tsx`、`streaming-cursor.tsx`、`message-utils.ts`、`MotionReveal.tsx`、`lib/motion/variants.ts`，并核对 `globals.css` 中 `.card*` / `.tool-card` / `.welcome-logo` / `runningBar` 相关规则。下列类名与状态机均可复验。

## Report

## [S1] Problem

### S1.1 准确表述（避免「不够好看」空话）

当前界面**完成度高、工程感强，但缺少「用完能复述的产品瞬间」**。

| 已有 | 证据 | 为何仍不「签名」 |
|---|---|---|
| 欢迎页逐字入场 | `home.tsx:287-310` + `letterUpVariants`（blur+上浮+35ms stagger） | 是通用 SaaS 标题动效；文案 `Code with Agent` + BrandMark 与顶栏同构，**无第二眼记忆点** |
| 工具卡 running 态 | `globals.css:2459-2493`：spinner 图标替换、左缘 `runningBar` 脉冲条、状态点 `pulseDot` | 功能正确，但是「卡片+徽章+转圈」的通用实现；**执行成功后无收束**，一眼与其他 AI 工具无差别 |
| 文件变更卡 | `file-change-card.tsx`：+n/-m、created/modified 徽章、可展开 diff | 信息密度好，仍是折叠卡列表 |
| 流式光标 | `streaming-cursor.tsx`：accent 竖条 + blink | 仅提示「还在写」，非品牌瞬间 |
| 动效体系 | `MotionVault` 式 variants + `MotionReveal` + 全局 `MotionConfig reducedMotion="user"`（`AppShell.tsx:239-241`） | 设施够用；缺的是**用在产品主叙事上的编排**，不是缺库 |

**产品主叙事是什么（代码事实，非愿景）**：用户发指令 → Agent 调工具（读/改文件、跑命令）→ 产出结果。界面里**最高频、最区分品类**的面是 **工具执行生命周期**，不是登录页式标题动画。

### S1.2 为何不能靠「加特效」解决（与 P1 约束）

P1 宪法：quiet、品牌色稀缺、禁装饰渐变/彩色 blur 发光。因此签名必须来自：

- **状态编排**（时间上的节奏、收束、层级）
- **排版与图标语义**（标题衬线 / mono 元信息可复用；**不**叫「文学风」——产品未定过该设计轴，见 `design-identity.md` S1.2 更正）
- **结构变化**（展开/收束、左缘进度、成功后的静默完成）

而不是光晕、粒子、大幅 3D。

### S1.3 现状状态机（实现已齐，视觉未讲故事）

`message-utils.ts:53-63` `STATUS_BY_STATE`（编译期全量 Record）：

| ToolCallState | 展示类 | 文案键 | 现视觉 |
|---|---|---|---|
| `input-streaming` / `input-available` / `approval-responded` | `running` | statusRunning | spinner + 脉冲左条 + 发光点（含 glow） |
| `output-available` | `success` | statusSuccess | 普通 success 徽章，**无完成收束** |
| `output-error` | `error` | statusError | error 徽章 |
| `approval-requested` / `output-denied` | `pending` | statusWaiting | pending 徽章（琥珀） |

`ToolCallView` 默认折叠（`open` state），命令工具有 Terminal 图标 + 深色 code 块；`FileChangeCard` 复用同一 `.tool-card` 壳。

## [S2] Design

### S2.0 签名定义（验收用）

**签名时刻 = 工具执行「活 → 完」的可复述瞬间**（一次 agent 回合里最醒目的 1–2 秒）：

> 「左边那条线在走 → 突然收成一个小勾/静默完成 → 卡片安静落下」。

欢迎页只做**次签名**（排版级），不与工具链抢戏。

### S2.1 主签名：工具卡生命周期编排（ToolCallView + FileChangeCard）

在 **P1 实心化/去 glow 之后** 做（禁止用 glow 冒充签名）。

| 阶段 | 视觉契约（quiet） | 动效（≤200–250ms，尊重 reducedMotion） |
|---|---|---|
| **R1 运行中** | 左缘 2px `--accent` **进度线**（现 `runningBar` 脉冲可改为「呼吸或短扫」）；标题行等宽小字状态；图标 spin（现 `toolSpin` 保留） | 左缘线 opacity/位移呼吸；禁 `0 0 Npx` 发光 |
| **R2 成功收束（新）** | 左缘线 **收成 4px 竖点或短勾**（`--success` 或中性），状态徽章从 accent-soft 过渡到 success 文案；标题字重略增后回落 | 左缘「拉齐收束」180ms `ease-soft`；徽章色 150ms；**无缩放弹跳** |
| **R3 失败** | 左缘 `--error` 2px **静态**（不闪）；标题 `--error-text`；错误块默认**展开**（现需手点 open——签名要求错误可达） | 展开用现 grid-rows 200ms |
| **R4 审批等待** | 左缘 `--amber` 虚线/点线（现 pending）；与审批卡（`card.paused`）视觉同族 | 无无限动画（或极慢 opacity） |
| **R5 折叠完成** | 完成后卡片保持安静灰阶；hover 才显示 chev 提示 | 展开/折叠沿用现 `tool-chev` 旋转 |

**跨卡节奏（回合级，轻量）**：

- 同一 assistant 消息内连续工具卡：**纵向 4px 间距 + 左缘同轴**（现 `.msg-tool` 已近似），完成态左缘对齐成「履历线」。
- 不引入时间轴假节点、不编造并行 agent 动画。

**文件变更卡**：成功收束后，`+n/-m` 数字从 accent-soft **落到中性 mono**（统计即结果）；created/modified 徽章保留语义色。

**实现落点**（类名冻结优先，小步）：

1. CSS：`.tool-card:has(.card-status.running)::after`（2483）与 `@keyframes runningBar`（4025）改为无 blur 的线态；新增 `.tool-card.is-settled` 或基于 `:has(.card-status.success)` 的收束样式（避免 JS 大改）。
2. `ToolCallView`：`output-error` 时默认 `open=true`（组件一行级，可测）。
3. 可选增强：成功瞬间对 `.card-head` 加一次性 `data-settled` class → CSS 过渡（防动画重复）。
4. **禁止**改 `ToolCallState` 联合（类型已与 AI SDK 对齐）；只加展示态 class。

### S2.2 次签名：欢迎页品牌区（排版级，不抢戏）

在 P1 BrandMark flat 化之后：

| 项 | 现状 | 目标 |
|---|---|---|
| 字入场 | 逐字 blur-up（已有） | **保留**节奏，缩短总时长感（可保持 35ms stagger） |
| 字体 | `globals.css` `.welcome-logo` 用 `--font-serif` | **可保留衬线作排版选择**（非「文学风轴」）；按 TraeWork 复审，与 P1 C6 命名诚实一致 |
| BrandMark | 渐变+drop-shadow（P1 删） | flat `--accent` + 切角括号（与顶栏同一） |
| 副文案/快捷 pill | 4 pill + folder bar | 不扩功能；pill 错落入场已足够 |

**不做**：全屏粒子、3D、滚动叙事站、改产品名文案策略（`BRAND_TEXT = 'Code with Agent'` 保持，除非产品另有命名决策）。

### S2.3 流式与消息（只对齐、不另开战场）

- 流式光标：保留 blink；**去掉** `shadow-[0_0_8px_var(--accent-glow)]`（P1 V 系列一并处理），改为实色短竖条。
- 消息入场：现 `enter-anim` + `y:6` 足够；不为「记忆点」加长动画。
- 审批 `card.paused`：与 R4 同族（琥珀左缘），避免两套 pending 语言。

### S2.4 明确不做（防范围膨胀）

- 假进度条、假多 agent 分身、音效
- 欢迎页改布局/路由/信息架构
- 全站 hover 微动效大扫除
- 与 P1/P2/P3 冲突的渐变、字号重调、CSS 大拆（签名样式落点遵循 P3 的 `panels.css`/`motion.css` 归属）

## [S3] Out of Scope

- 身份收口细节（渐变/发光删除）→ `design-identity.md`（本题 **depends** 其 T3/T4）
- 令牌/字号 → `design-tokens-debt.md`
- globals 拆分工程 → `design-style-architecture.md`（本题新 CSS 优先落 `panels.css`/`motion.css`）
- 工具协议/后端 tool 结果形状
- 视觉回归以外的 E2E

## [S4] 验收（签名可测化）

| 项 | 方法 |
|---|---|
| 运行中有「活」感 | 人工：连续 2+ 工具执行，左缘运动可感知；`prefers-reduced-motion` 下变为静态左缘 |
| 成功有「收束」 | 人工 + 单测：`output-available` 后存在 settled 样式钩子（class 或 `:has(success)`）；无无限脉冲 |
| 失败可达 | 单测：`output-error` 默认展开 error 文本 |
| 与 quiet 兼容 | `rg "0 0 [0-9]+px"` 在 tool-card 相关规则为 0（允许 `0 0 0 Npx` ring） |
| 无像素级回归意外 | `pnpm test:visual`：允许 tool-card/welcome **有意** diff，需在 PR 附前后说明；其余面零 diff |
| 命令 | `pnpm test:renderer`（tool-call / file-change / message-utils）+ `check:animations` + `check:tokens` 绿 |

## Tasks

- [ ] T1: 工具卡 running 态去 glow、左缘线 quiet 化 — acceptance: R1 契约；`check:tokens` 绿 (covers: S2.1)
- [ ] T2: 成功收束态（左缘收束 + settled 过渡） — acceptance: R2 可人工复述；`output-available` 有稳定样式钩子 (covers: S2.1; depends: T1)
- [ ] T3: 失败默认展开 + 错误左缘 — acceptance: R3；`tool-call-view` 单测覆盖 (covers: S2.1; depends: T2)
- [ ] T4: pending/审批与 `card.paused` 同族 — acceptance: R4；无双套琥珀语言 (covers: S2.1; depends: T2)
- [ ] T5: FileChangeCard 统计收束 + 流式光标去 glow — acceptance: S2.3；visual 仅 tool/cursor 区预期 diff (covers: S2.3; depends: T2)
- [ ] T6: 欢迎页次签名对齐 P1（flat BrandMark，保留逐字） — acceptance: S2.2；reducedMotion 下可无动画 (covers: S2.2)
- [ ] T7: 验证与文档 — acceptance: S4 全绿并记录；08/09 若描述工具卡状态视觉则同步 (covers: S4; depends: T3, T5)

## 决策记录（供审查）

| 决策 | 选择 | 依据 | 放弃 |
|---|---|---|---|
| 主签名面（4.1=A） | **工具执行生命周期** | 品类核心瞬间 | 重做欢迎页大秀（否决） |
| 成功态（4.2=A） | **新增视觉收束** | 完成是叙事终点 | 只优化 running（否决） |
| 欢迎页（4.3=A） | **次签名，保留逐字入场** | 已有 70 分 | 整页重做（否决） |
| 依赖（4.4=A） | **P1 去 glow 之后做** | 否则签名与身份债互相污染 | 并行（否决） |
| 手法 | **状态收束 + 排版节奏** | 服从 P1 quiet | 发光/渐变/粒子 |
| 类名策略 | **优先 `:has()`/状态 class 小步** | 降 TSX 风险 | 大改组件树 |

> **诚实说明**：问题 4 含审美判断，不如 P1–P3 可纯证伪。本方案把「记忆点」收成可验收的状态收束与失败可达，而不是写空泛的「更高级」。
