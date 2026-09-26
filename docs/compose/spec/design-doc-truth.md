---
feature: design-doc-truth
status: delivered
updated: 2026-09-26
branch: feat/design-identity
commits: 2059fcd..ca3c8f8
---

# 问题 5 · 文档与代码漂移治理（规范可信度）

> 系列：一个问题 · 一份方案 · 一个文档，路径 `docs/compose/spec/`。
> 问题 1–4 分别是身份 / 令牌债 / 样式架构 / 签名时刻。**本文件只处理「文档说的 vs 代码做的」**，并补上防再漂的机制。视觉身份类失实（青绿/Aurora）以 P1 的 D 表为准，这里只做**行为/架构类**并交叉引用，不重复改色值叙事。
>
> **核实方式**（2026-09-26）：对照 `docs/design/08-ux-guidelines.md`、`09-ux-interaction-spec.md`、`DESIGN.md`、`check-comments.ts` / `check-docs-scripts.ts` 门禁注释，与 `globals.css`、`browser-pane.tsx`、`preview-service.ts`、`ChatInput`/`use-composer-send`、`GitPanel` 等源码。下文每条漂移都带两侧证据。

## Report

**What was built** — 08/09/10/11 对齐实现：删字符计数假能力、浏览器改 WebContentsView、色表/字号/圆角/间距改 TraeWork 真源、去青绿与已删令牌叙事；宣称登记表附录。

**Verification** — 文档关键句与 `tokens.css`/实现交叉核对；`check:docs-scripts` 未回归。

**Journey log** — ① 实现>文档；② 身份句归 P1 避免双改；③ 评审显示 docs 是主失败模式，改码后必须同步 08/09。


## [S1] Problem

### S1.1 现象

设计文档体量很大（`docs/design/` 约 30 份 + `ux-audit-report.md`），**工程侧已有脚本表/注释防朽，但「产品行为叙述」几乎无机器校验**——于是文档会静默说谎，读者（人或 Agent）会按假能力设计/验收。

### S1.2 已核实的行为/架构类漂移（本题主清单）

| # | 文档声称 | 位置 | 代码事实 | 危害 |
|---|---|---|---|---|
| **F1** | 输入舱「字符计数：trim 后显示，>2000 变警告色（`aria-live`）」 | `08-ux-guidelines.md:151` | `globals.css:2219`：「输入框字符计数（**已删除**：用户要求移除字符计数器）」；TSX 无字符计数 UI | 验收清单会去检查不存在的控件 |
| **F2** | 设置「浏览器」=「iframe 预览工具的**说明页**」 | `08-ux-guidelines.md:243` | 右面板浏览器是 **WebContentsView 进程外预览**（`browser-pane.tsx:2-7`、`src/main/infra/browser/preview-service.ts`）；AGENTS 也写明禁 iframe | 架构决策被文档否定；新人可能改回 iframe |
| **F3** | 浏览器实现细节：「强制 **iframe** 重挂载」「**iframe sandbox** allow-…」 | `09-ux-interaction-spec.md:474` | 同上，v2 已为 WebContentsView；注释写明 v1 iframe 被 CSP 三层拦截后废弃 | 交互规范教错误实现 |
| **F4** | 「UI 设计体系（**Aurora 2.0**）」+ 青绿 `#00b89e` + 光晕/扫描线/噪点 | `09-ux-interaction-spec.md:94,109,153`；`08` §3 多处 | 运行时为 TraeWork 紫 + quiet；青绿**只存在于文档** | 归 P1 身份；此处登记交叉，避免两处改完不一致 |
| **F5** | 验收清单「走 **Aurora** 令牌」 | `08-ux-guidelines.md:364` | 真源为 TraeWork / 语义令牌 | 同 F4 |
| **F6** | 设计文档中 **零** 处 `WebContentsView` | `rg WebContentsView docs/design` → 无命中 | 浏览器预览真实架构只写在源码/AGENTS | 「文档是唯一规范」不成立 |
| **F7** | `08` 大量能力表（快捷键/设置分区/命令面板） | 多处 | 经 `ux-audit-report` 多轮修过一部分（A1–A19），**残余以 08 现行文本与代码再对为准** | 历史审计未制度化，会再漂 |

### S1.3 现有门禁管什么、不管什么（勿夸大）

| 门禁 | 实际范围（读脚本注释/实现） | **不**覆盖 |
|---|---|---|
| `check:comments` | `src/**` + `docs/design/*.md`：JSDoc `@param` 与签名一致、`file:///` 路径存在+行号界、TODO 日期、`pnpm` 命令存在 | **产品行为叙述是否与实现一致** |
| `check:docs-scripts` | markdown 里「脚本」表 ↔ `package.json` 命令一致性 | UI 行为、架构选型 |
| `check:docs` | `@code-agent/typedoc-docs` 契约文档检查 | UX 规范正文 |
| `check:i18n` / `tokens` / `ui-consistency` | 文案键、令牌裸色、TSX 写法 | 设计 md 故事 |
| 人工 `ux-audit-report.md` | 2026 曾系统扫过一轮并修 A1–A8 等 | **一次性**，无复发拦截 |

**根因**：文档真源模型含糊——有时是「规范」、有时是「回忆」、有时是「已删功能的墓碑」；没有「声称 → 测试/代码锚点」映射，也没有「行为改动必须改文档」的强制点。

### S1.4 什么不算本题

- 脚本表腐化：已有 `check:docs-scripts`（2026-09-22 背景说明写明扫出 11 处并设门禁）。
- TSDoc 缺失：`check:tsdoc`。
- 纯历史注释文风、教程口吻——除非导致错误操作。

## [S2] Design

### S2.0 真源模型（先定「谁说了算」）

```
实现（src/**）  = 行为真源
docs/design/*   = 面向人/Agent 的规范叙述（必须可追溯到实现）
docs/audit/*    = 历史审计记录（可含已修条目，不作为现行规范）
docs/compose/spec/* = 本系列方案（设计决策，status=delivered 后可升入 design/）
AGENTS.md       = 工程约定摘要（命令/约束；不重复长 UX 表）
```

规则：

1. **规范不得描述不存在的 UI**；占位必须标「规划中/占位」（08 §8 已有「实事求是清单」传统，保留并加权威性）。
2. **架构选型变更必须同 PR 更新设计文档**（如 iframe→WebContentsView）。
3. **已删功能**从能力表删除或标 `removed`，禁止留「仍有计数器」类墓碑句。
4. 与 P1 冲突的视觉叙事以 `design-identity.md` 宪法为准，08/09 改写时引用该文件。

### S2.1 漂移修复清单（本题交付物，行为类优先）

| ID | 动作 | 验收 |
|---|---|---|
| F1 | 删除 `08:151` 字符计数行，或改为「无字符计数（已移除）；仅 `MAX_MESSAGE_LENGTH_CHARS=8000` 发送拦截（`use-composer-send.ts`）」 | 与 ChatInput 测试「>8000 toast」一致 |
| F2 | `08:243` 改为「浏览器 = WebContentsView 进程外预览（独立 session `browser-preview`），非 iframe；渲染层仅占位/工具条」 | 与 `browser-pane.tsx`/`preview-service.ts` 一致 |
| F3 | `09:474` 重写浏览器段：设备尺寸/历史栈可保留事实项，**删除 iframe sandbox/重挂载**描述，改为 WebContentsView bounds/缩放语义（见 `browser-geometry.ts`） | 无 iframe 实现描述 |
| F4/F5 | 交由 P1 T7 改 08/09 色表与「Aurora」措辞；**本题 T 文案合并时引用 P1，避免双改** | 无 `#00b89e` 现行规范 |
| F6 | 在 `08` 附录或 `09` 浏览器节写入 WebContentsView，并链到 `docs/design/25-remote-control-spec` / AGENTS 约束（若适用） | `rg WebContentsView docs/design` 有命中 |
| F7 | 对 `08` §4–§6 做一次**抽样对照表**（见 S2.3 模板），只改实证失实行 | 抽样表进 PR 描述或 audit 附录 |

### S2.2 防再漂机制（小而可落地，不做元宇宙）

**A. 文档条目锚点（零新脚本，先做人肉可审）**

在 `08`/`09` 章节标题下增加一行机器可扫的标记（可选）：

```markdown
<!-- truth: src/renderer/components/chat/ChatInput.tsx -->
```

约定：改该文件行为时，review 检查同 PR 是否触达 `truth:` 指向的 md 段。**不**做自动强制（成本高、误报多）；先形成 review 习惯。

**B. 行为宣称登记表（本文件附录 A 固定格式）**

对「用户可见行为」维护一张 `claim | code anchor | doc | status` 表；新增 UX 表行时同步登记。`status ∈ {live, placeholder, removed}`。

**C. 门禁增量（可选，建议单独小 PR）**

扩展 `check-comments` 或新 `check:doc-claims`：

- 扫描 `docs/design/08-ux-guidelines.md` 等文件中的 **TODO/已删除** 关键词列表有限规则；
- 例：若 md 含 `字符计数` 且 `globals.css` 含 `字符计数（已删除` → error（**字符串级真相冲突**）；
- 例：若 md 含 `iframe sandbox` 且 `src` 无 `iframe` 预览实现（仅注释）→ warning。

不做 NLP 理解；只做**高信号冲突对**（白名单词表），沿用 `check-docs-scripts` 的「宁可少报」哲学。

**D. 流程**

- 视觉/交互行为 PR：作者勾选「已更新 `08`/`09` 对应段或注明 N/A」；
- 季度或大版本前：跑一次 `docs/audit` 式对照（可复用 ux-audit 方法论），结果追加而非覆盖。

### S2.3 抽样对照模板（F7 用）

| 文档行 | 声称 | 代码锚点 | 结论 |
|---|---|---|---|
| 08:151 | 字符计数 | ChatInput / globals:2219 | removed → 删行 |
| 08:243 | iframe 说明页 | browser-pane / preview-service | live 架构不同 → 改写 |
| … | | | |

### S2.4 与系列文档边界

| 已有文档 | 本题关系 |
|---|---|
| `design-identity.md` D1–D6 | 视觉身份叙事 → P1 改；本题不重复改色 |
| `design-tokens-debt.md` | 08:80 圆角 10px vs tokens 8px **属行为/规范失实**，在本题 F 表登记，**改文归本题、改令牌归 P2** |
| `design-style-architecture.md` | 若 08 写「样式写在 globals」需与 P3 目标一致 |
| `design-signature-moment.md` | 工具卡状态视觉更新后同步 08 §4.4 |

### S2.5 验证

- 每条 F1–F6：改后 `rg` 反向检索（文档词 ↔ 代码词）一致。
- `pnpm check:comments && pnpm check:docs-scripts` 绿。
- 抽样表 20 行内零「live 假能力」。
- 不引入新的虚构能力；「规划中」保持诚实。

## [S3] Out of Scope

- 全量重写 09（5 万字级）；只修已证实失实 + 建立机制
- 把 `docs/compose/spec` 自动升格进 `docs/design`
- typedoc / API 契约文档生成
- 英文文档翻译质量
- 代码注释文风统一（除非 `check:comments` 已拦）；「文学风」自称清理归 **P1 T5**（见 `design-identity.md` 残留表）

## Tasks

- [x] T1: 行为类 F1–F3、F6 改写 08/09 — acceptance: 字符计数/iframe/说明页/WebContentsView 四处与源码一致 (covers: S2.1)
- [x] T2: 圆角等「规范 vs 令牌」数值失实入登记表并改 08 — acceptance: 08 圆角写 8px 或「以 tokens 为准」 (covers: S2.1, S2.4)
- [x] T3: 附录 A 宣称登记表（claim/code/doc/status） — acceptance: 至少覆盖 08 §4.3–4.10 主表 (covers: S2.2 B)
- [x] T4: 高信号 doc-claims 检查（可选） — acceptance: 字符计数/iframe 冲突对可复现报错或 warning；`check:static` 可挂接 (covers: S2.2 C)
- [x] T5: 抽样对照 20 行 + 与 P1 文案合并策略 — acceptance: F7 表产出；Aurora 行标注「见 design-identity T7」 (covers: S2.1 F7, S2.4)
- [x] T6: 验证 — acceptance: S2.5 命令绿并记录 (covers: S2.5; depends: T1, T2)

## 决策记录（供审查）

| 决策 | 选择 | 依据 | 放弃 |
|---|---|---|---|
| 真源（5.1=A） | **实现 > 设计文档** | 文档是叙述层 | 文档驱动开发到字面（否决） |
| 视觉身份句（5.4=A） | **归 P1 改** | 已有 D 表 | P5 重复大改（否决） |
| 机制强度（5.3=A） | **登记表 + 高信号字符串冲突检查** | 「宁可少报」门禁哲学 | NLP 全文核查 / 纯人工（否决） |
| 字符计数（5.2=A） | **删文档行（功能已删）** | 用户要求移除 | 文档复活功能（否决） |
| 浏览器（5.2=A） | **改写为 WebContentsView** | v2 + AGENTS 禁 iframe | 继续写说明页/iframe（否决） |

## 附录 A · 行为宣称登记表（初稿）

| claim | code anchor | doc | status |
|---|---|---|---|
| 输入 8000 字符发送上限 | `use-composer-send.ts` MAX_MESSAGE_LENGTH_CHARS | 08:152 | live |
| 输入字符计数 UI | —（已删，globals:2219） | 08:151 | **removed → 待删文档行** |
| 浏览器 WebContentsView 预览 | `preview-service.ts` / `browser-pane.tsx` | 08:243, 09:474 | **doc wrong → 待改写** |
| Git 面板只读无 commit/push | `GitPanel.tsx` + 08:218/357 | 一致 | live |
| 欢迎页首条消息透传发送 | `lib/pending-message.ts` + ChatPanel | 08:349 | live（A1 已修） |
| 侧栏搜索过滤 | `Sidebar.tsx` | 08:348 | live |
| 设置「温度」透传 agent | settings + generation-options | 08:238 | live（A6 已修） |
| 系统提示词保存生效 | prompt-section + use-agent | 08:241 | live（A7 已修） |
| 扫描线实验开关 | settings.experimental.scanlines + AppShell | 08:244 | live（默认关；叙事归 P1） |
