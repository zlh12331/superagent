---
feature: design-identity
status: delivered
updated: 2026-09-26
branch: feat/design-identity
commits: 2059fcd..ca3c8f8
---

# 问题 1 · 设计身份收口（TraeWork 唯一化）

> 系列：一个问题 · 一份方案 · 一个文档，路径 `docs/compose/spec/`。
> **范围**：身份 =「界面看起来是谁 / 代码如何自称」。不含字号双轨、globals 拆文件、签名动效、文档行为事实（后四者见同目录 P2–P5）。
>
> **核实方式**（2026-09-26，只读、可复验）：
> 1. 全文读：`DESIGN.md`、`tokens/aurora.json` 开头与别名段、`tokens.css` 注释架构、`globals.css` 哲学头（1–23）与品牌/头像/发送钮段、`BrandMark.tsx`、`Sidebar.tsx` 头注释、`Topbar.tsx` 头注释。
> 2. 定量扫：`rg` 统计 renderer 内 `Aurora/aurora` / `TraeWork` / `文学风` / `--aurora-*`；青绿 hex 是否仍在运行时。
> 3. 交叉：与 `08-ux-guidelines` / `09-ux-interaction-spec` / `10-component` / `11-a11y` 对照。
> 下文凡写「已核实」均可在上述文件按行号复现。

## Report

**What was built** — TraeWork 身份收口：DESIGN.md 宪法 C1–C6；品牌面（新建钮/头像/发送钮/BrandMark）实心化；删除 12 个 `--aurora-*` 并迁移消费；清除彩色 blur 发光（保留 soft ring）；删除死类 `.prose-literacy`；注释去 Aurora/「文学风」自称。

**Verification** — `tokens:check` / `check:tokens` / `check:css-vars` / `typecheck` / `test:renderer`（1534）/ `test:visual`（4）通过；评审后补 streaming-cursor 去 glow 与文档对齐。

**Journey log** — ①「文学风」不是设计轴，勿写入宪法；② 品牌渐变与 quiet 冲突须一次禁干净；③ `--aurora-*` 与文件名 `aurora.json` 分离决策（1.3=A）。


## [S1] Problem

### S1.1 一句话

**色彩已经 TraeWork，品牌面还穿 Aurora 装饰，注释里还留着已死的 Aurora/「文学风」自称**——真源与叙事不同步。

### S1.2 修正后的模型（无「文学风设计轴」）

> **重要更正（2026-09-26，用户指出后复核）**：产品**从未定过**「文学风」设计体系。代码/`index.html` 里的「文学风」只是早期实现的注释口头禅与残留（Google Fonts 衬线、`--ink-brown` 选区、死类 `.prose-literacy`）。**唯一视觉真源 = TraeWork quiet**。禁止把「文学风」写入宪法或当成第二设计轴。

| 层 | 现行身份 | 用户可感？ | 现状 |
|---|---|---|---|
| **L1 色彩/表面** | **TraeWork**（紫 `#4B3FE3` / 暗 `#6A6FFF`，中性灰阶，quiet） | 是 | `tokens`/`globals` 哲学头已写明；`rg #00b89e src` **0 命中** |
| **L2 装饰语法** | 混：Aurora 遗产（双 accent 渐变、发光）+ 部分已 quiet 化 | 是（主 CTA/头像最明显） | 顶栏发光刻度线已删，按钮/头像仍渐变发光 |
| **残留（非设计轴）** | 注释自称「文学风」+ 零散排版/效果 | 弱（选区、个别衬线） | 见下：死样式与假叙事，应清理而非「保留成轴」 |

**残留清单（清理对象，不是设计意图）**：

| 项 | 证据 | 处置 |
|---|---|---|
| `.prose-literacy` 整段 CSS | TSX **0 引用** | **删除** |
| 注释「文学风 / 米黄 / 深棕」 | Sidebar/FileTree/EmptyState/Metrics/Logs/Inspector/Terminal/Git/index.html 等 | **改事实描述**（衬线标题 / mono 元信息 / 选区色） |
| `--ink-brown` 选区/blockquote | `debt.md` D7 已令牌化（门禁收口时起的名） | 可留作效果色；要更 quiet 可改中性选区（附带小项） |
| `font-serif` 用于品牌字/欢迎页 | 排版选择，非「文学风轴」 | **默认可留**，按 TraeWork 复审；不写入身份叙事 |
| Noto Serif SC（Google Fonts） | `index.html` 注释称「文学风字体」 | **独立产品决策**（字体/离线策略），与身份解耦 |

### S1.3 证据 A · 定量与逐条视觉残留

**词频（renderer，已核实）**

| 词 | 主要落点 | 量级 |
|---|---|---|
| `aurora`/`Aurora` | `globals.css` **46**、`tokens.css` **13**、`use-resizable-panels.ts/test` **6**、`ChatInput`/`Topbar`/`layout-utils*` **4** | ≈69 处 |
| `--aurora-*` 仅 globals 消费 | 同上 | **35** 处引用 + **12** 个键定义 |
| `TraeWork` | `tokens.css` **54**、`globals.css` **15**、`index.html` **3** | 已是注释主叙事 |
| `文学风`（注释词） | index.html / Sidebar / FileTree / EmptyState / Terminal / Git / Metrics / Logs / Inspector 等 | 10+ 文件，**仅注释自称，非设计轴** |

**视觉残留（用户看见；`globals.css` 行号以 2026-09-26 为准）**

| ID | 元素 | 位置 | 已核实现状 | 与 TraeWork quiet 冲突 |
|---|---|---|---|---|
| V1 | `.new-thread-btn` | 719–751 | 注释「Aurora：双 accent 渐变 + 发光」；`linear-gradient(accent→accent-2)` + `glow-sm`；hover `glow-md` + `translateY(-1px)` + `brightness` | 主 CTA |
| V2 | `.msg-avatar.assistant` | 1643–1648 | `linear-gradient(accent→accent-2 140%)` + 外 `glow-sm` + inset 高光；字色 `--ink` | 消息流品牌位 |
| V3 | `.send-btn` | 2222–2259 | `linear-gradient(accent→accent-dim)`；hover `glow-md` + 位移；active `scale` | 主操作 |
| V4 | 欢迎页品牌 | `home.tsx:297` `BrandMark variant="gradient"`；`globals.css:1123-1130` `.wl-icon` `drop-shadow(0 0 12px accent-glow)`；`BrandMark.tsx:9-11,41-53` 明文两种 variant | 与顶栏 flat **双面孔** |
| V5 | 侧栏激活 | 1057–1058 | `0 0 8px accent-glow` | 装饰发光 |
| V6a | `.card:hover::before` | 2341–2343 | `0 0 10px accent-glow` | |
| V6b | `.card-status.running::before` | 2397–2405 | 呼吸点 `0 0 6px accent` | |
| V6c | `.card.paused` | 2772–2778 | `0 0 10px amber-glow` + 头渐变 | |
| V6d | `.stop-gen-btn:hover` | 2284–2286 | `0 0 14px error` | |
| V6e | `.file-viewer-dirty-dot` | 3281–3288 | `0 0 6px amber-glow` | |
| V6f | `.async-refreshing-bar` | 3922–3929 | 渐变条 + `0 0 8px accent-glow` | |
| V6g | `@keyframes runningBar` | 4025–4036 | `0 0 4/12/20px` 脉冲发光 | |
| V7 | Composer focus 发丝 | 2056–2081 | **仅 focus 时** accent 渐变线 + `drop-shadow` | 可降为 soft ring |

**勿误伤（已核实为中性/功能，不是身份债）**

| 位置 | 形态 | 判定 |
|---|---|---|
| `.composer` 2012、`.card` 2313、`.sidebar-foot .avatar` 972 | 灰阶 linear-gradient | 可留 |
| `.composer::before` 2028–2034 | border-strong 发丝 | 可留 |
| 骨架 shimmer 3597/3616 | 灰阶扫光 | 功能 |
| `0 0 0 Npx` soft ring（653、2073、3027、4021 等） | 焦点环 | 可留（C4 白名单） |
| `.scanlines-overlay` 3545–3557 | 实验、默认关 | 非默认身份（附带：`z-index: 9999` 未走 `--z-boundary`，记 P3） |

### S1.4 证据 B · 命名与注释（开发者看见）

| ID | 位置 | 内容 |
|---|---|---|
| N1 | `tokens/aurora.json:559-598` → `tokens.css:212-226` | **12** 个 `--aurora-*`「兼容别名」 |
| N2 | `globals.css` 布局/焦点/激活 | 35 处 `var(--aurora-*)` |
| N3 | `use-resizable-panels.ts:116-118` + 测试 | 运行时写 `--aurora-sidebar-w/right-panel-w` |
| N4 | `globals.css:375-381` | 「保留 --aurora-* 避免 shadcn 冲突」+ 旧青绿 `#00f0d0/#00e5c7` 注释；**现 `--aurora-accent` 已是 `var(--accent)`，冲突理由对 color 不成立** |
| N5 | `globals.css:372` | 「文学风视觉令牌（米黄/深棕）」——**假叙事**：非设计轴 + 表面早已是灰阶 |
| N6 | `globals.css` 分节 | 1617「消息流 · Aurora」、2007「Composer · Aurora」、2306「卡片系统 · Aurora」、2897「空状态 · Aurora」、3580「骨架屏 · Aurora shimmer」、3849「Aurora 动画」 |
| N7 | `ChatInput.tsx:2` | 「Aurora 设计系统」 |
| N8 | `Topbar.tsx:2-10,51` | 「双 accent 发光刻度线（青→蓝紫→青）」「--aurora-topbar-h」；**CSS 已删刻度线**（`globals.css:502`） |
| N9 | `window.ts:116` 等主进程注释 | `--aurora-topbar-h` |
| N10 | `Sidebar.tsx:14` | 「文学风视觉令牌：**深棕主色**」——主色实为紫/灰；删「文学风」自称 |
| N11 | `TerminalView.tsx:91` / `index.html` | 「文学风主题/字体」——改事实描述，不称设计体系 |
| N12 | `DESIGN.md:3,11,42` | 标题/frontmatter「Aurora Design Tokens / Aurora Light / Aurora Dark」；**同文件 §1:36 已写「TraeWork 无 glow」**——文件内自相矛盾 |

### S1.5 证据 C · 规范文档（决策者看见）

| ID | 位置 | 失实 |
|---|---|---|
| D1 | `08:71-77` | 「Aurora 2.0」+ 青绿 `#00b89e` + 蓝 `#2b7fff` |
| D2 | `08:81`、`09:130` | 「衬线（文学风）」措辞——**删「文学风」字样**，改「标题衬线 / mono 元信息」 |
| D3 | `08:364` | 验收「走 Aurora 令牌」 |
| D4 | `09:94,109-110,153-154` | 「Aurora 2.0」体系表 + 光晕/扫描线/噪点 |
| D5 | `10:30`、`11:23` | 「Aurora 令牌」 |
| D6 | （交叉 P5） | `08:243` 浏览器说明页等**行为漂移**不属本题 |

### S1.6 根因（多轮分析后的四条，均可指认）

1. **换轨只完成 L1（令牌值）**，L2 装饰语法与品牌 API（`BrandMark` gradient）未换。
2. **无身份宪法**：TraeWork 规则埋在 `tokens.css`/`globals.css` 注释；`DESIGN.md` 标题层仍 Aurora。
3. **「文学风」被误当成设计层**：实为注释自称 + 死样式 `.prose-literacy`（TSX 0 引用）+ 已收口的 `--ink-brown` 效果色；**不是**产品定过的设计轴。
4. **门禁不拦身份**：`check:tokens` 拦裸色/hex/z-index，**不拦**渐变、`0 0 Npx` 发光、「Aurora 设计系统」措辞。

## [S2] Design

### S2.0 身份宪法（实现与 P2–P5 的唯一视觉真源）

| 项 | 定论 |
|---|---|
| UI 产品名 | Code Agent desktop（`BRAND_TEXT`/productName，不在本题改名） |
| 设计系统名 | **TraeWork**（与 `tokens.css` 既注释一致） |
| 历史名 | Aurora = deprecated；仅允许在「迁移说明」出现一次并标注 |

**单一 TraeWork 轴（无「文学风」轴）：**

```
TraeWork（表面 / 色彩 / 装饰 / 排版均服从此宪法）
├─ 中性灰阶 + 紫 accent 稀缺
├─ quiet：无品牌渐变、无 blur 发光
├─ 中性阴影 / 0 0 0 Npx soft ring
├─ 品牌面实心 --accent / --primary
└─ 排版：font-sans UI；font-serif 仅作标题/品牌字选择（不称「文学风」）
```

| 条 | 规则 | 禁止 | 允许 |
|---|---|---|---|
| C1 | 表面 quiet | 默认品牌渐变、彩色 blur 发光、默认噪点/扫描线 | 灰阶淡变、实验 scanlines 默认关 |
| C2 | 品牌色稀缺 | 大面积紫装饰 | 主按钮、选中、焦点、关键状态 |
| C3 | 品牌面实心 | `accent→accent-2` 渐变填充 | flat + `--ink`/`--on-accent` 字色 |
| C4 | 阴影中性 | `0 0 Npx` 彩色 glow、`drop-shadow` 氛围 | `--glow-*`（实为 shadow）、**`0 0 0 Npx` soft ring（1.4 = A 已拍板，白名单）** |
| C5 | 状态色层 | 状态用 blur 发光强调 | 描边 + `-*-text`/`*-emphasis`/`*-soft` |
| C6 | 命名诚实 | 称 Aurora 为现行；把注释「文学风」写成设计轴；「米黄/深棕」指灰阶表面 | 历史说明一次 + deprecated |

### S2.1 命名收敛

| 对象 | 决策 | 依据 |
|---|---|---|
| `tokens/aurora.json` 文件名 | **保留（1.3 已拍板 = A）** | `check-tokens-sync.ts` / `build-tokens.mjs` format `aurora/css` / 文档路径连锁；仅在 json 头注释标明「历史文件名 · 内容为 TraeWork」 |
| `build-tokens.mjs` 内 format 名 `aurora/css` | **保留** | 实现细节 |
| 12 个 `--aurora-*` | **删除**，消费改规范名 | 见映射表 |
| 布局运行时覆盖 | 写 `--sidebar-w` / `--right-panel-w` | `setProperty` 覆盖 clamp 默认值，语义与现 `--aurora-sidebar-w` 相同 |
| 注释/文档「Aurora」 | TraeWork 或中性 | N4–N12、D1–D5 |

**映射（同一变更集内改完；`check:css-vars` 防悬空）**

| 删除 | 改用 | 典型消费 |
|---|---|---|
| `--aurora-accent` / `--aurora-accent-2` | `--accent` / `--accent-2` | 焦点、激活、色字 |
| `--aurora-accent-glow` / `--aurora-accent-2-glow` | `--accent-glow` / `--accent-2-glow` | soft 底/ring（保留合法用法） |
| `--aurora-glow-sm/md` | `--glow-sm/md` | 阴影 |
| `--aurora-glass-bg` | `--glass-bg` | 顶栏 |
| `--aurora-ease-out` | `--ease-out` | 动效 |
| `--aurora-sidebar-w` / `--aurora-right-panel-w` | `--sidebar-w` / `--right-panel-w` | grid + resizer JS |
| `--aurora-resizer-w` / `--aurora-topbar-h` | `--resizer-w` / `--topbar-h` | grid / .topbar / 注释 |

### S2.2 视觉契约（只动已核实残留点）

> **决策锁定（2026-09-26）**：1.2 = **方案 A · 全禁**。V1–V4 一律实心；不保留发送钮/欢迎页渐变。

**V1 `.new-thread-btn`**：`background: var(--primary)`；去 gradient / hover `glow-md` / `brightness` / `translateY`；hover 可用 `color-mix` 略深。字色 `--primary-foreground` 不变。

**V2 `.msg-avatar.assistant`**：`background: var(--accent)`；`--ink` 字色保留；删外 `glow-sm`；可留中性 inset 高光。

**V3 `.send-btn`**：`background: var(--primary)`；删 hover 发光与位移；`scale(0.94)` active 可留；disabled 灰化保持。

**V4 BrandMark**：删除 `variant="gradient"` 与 `home.tsx` 传参；全站 flat。`.wl-icon` 去 `drop-shadow`。`BrandMark.tsx` 文档头改为「唯一 flat」。若 knip 无 gradient 用例则删 prop。

**V5–V6a–g**：去彩色 `0 0 Npx` / `drop-shadow`；状态改 soft 底或描边；`runningBar` 改透明度/soft ring，禁 blur。

**V7**：推荐只留 `focus-within` soft ring（2073），删 focus 发丝 `drop-shadow`（2067）。

**不改**：灰阶渐变、骨架 shimmer、soft ring、`::selection` 墨水、衬线标题、scanlines 功能本体。

### S2.3 文档与注释

| 目标 | 动作 |
|---|---|
| `DESIGN.md` | 标题/frontmatter/主题名 → TraeWork；写入 S2.0 两轴；删「Aurora Light/Dark」 |
| `08-ux-guidelines` §3 | 按现行 tokens 重写（紫、radius 8px、quiet）；§3.3 对比度现值；验收行「Aurora」→ TraeWork |
| `09-ux-interaction-spec` §二 | 色表与氛围对齐；「文学风标题」改为「标题衬线」 |
| `10` / `11` | 「Aurora 令牌」→「TraeWork / 语义令牌」 |
| `globals`/`ChatInput`/`Topbar`/`Sidebar`/`Terminal`/`index.html` 注释 | 删假色词与「文学风」自称；改事实描述；**删 `.prose-literacy`** |
| P2–P5 文档 | 必须引用 S2.0，不得另立视觉真理 |

### S2.4 验证

**命令**：`pnpm tokens:check` / `check:tokens` / `check:css-vars` / `check:animations` / `typecheck` / `lint` / `test:renderer` / `test:visual`（quiet 收口**预期** tool/CTA 区 diff，PR 说明）。

**反向 grep（收口完成判据）**

- `rg "\-\-aurora-" src` → 0（除迁移说明）
- `rg "Aurora 设计系统" src` → 0
- `rg "#00b89e|#00e5c7" src DESIGN.md docs/design` → 0
- `rg "linear-gradient\(135deg, var\(--accent\)" src` → 0（品牌渐变）

**人工（亮/暗）**：新建按钮实心无发光；头像实心；发送钮实心；欢迎页=顶栏 BrandMark flat；焦点 ring 仍可见；文本选区仍为墨水淡棕。

**不做**：E2E 全量、改 `aurora.json` 文件名、删 scanlines、字号/别名（P2）、CSS 拆分（P3）、签名新视觉（P4）。

## [S3] Out of Scope

- `--fs-*` / `--text-dim` 等令牌债 → `design-tokens-debt.md`
- `globals.css` 分文件 → `design-style-architecture.md`
- 工具卡签名态 → `design-signature-moment.md`
- 文档行为事实（字符计数/iframe 等）→ `design-doc-truth.md`
- 不把「文学风」升格为设计轴；产品改名；`remote-web-client` 作用域 CSS；Google Fonts 是否继续拉 Noto Serif（独立字体策略）

## Tasks

- [x] T1: 宪法写入 `DESIGN.md` — acceptance: **单一 TraeWork 轴** + C1–C6（无文学风轴/C7）；无「Aurora Light/Dark」现行表述 (covers: S2.0, S2.3)
- [x] T2: 12 个 `--aurora-*` 删除与引用迁移 — acceptance: 反向 grep 为 0；resizer 拖拽/折叠单测过 (covers: S2.1; depends: T1)
- [x] T3: V1–V4 品牌面实心化 — acceptance: 契约 S2.2；BrandMark 全站 flat (covers: S2.2; depends: T1)
- [x] T4: V5–V7 发光语法清零 — acceptance: 无彩色 blur/drop-shadow（ring 白名单）；`check:tokens` 绿 (covers: S2.2; depends: T3)
- [x] T5: 注释/假色词清理 + 删 `.prose-literacy` — acceptance: N4–N12 与实现一致；全仓无「文学风」作为设计自称；prose-literacy 零残留 (covers: S2.1, S2.3; depends: T2, T4)
- [x] T6: 08/09/10/11 对齐 — acceptance: 无现行青绿/Aurora 验收措辞；对比度与 radius 与 tokens 一致 (covers: S2.3; depends: T5)
- [x] T7: 验证与视觉基线 — acceptance: S2.4 命令与反向 grep 全过；test:visual 附 quiet 说明 (covers: S2.4; depends: T4, T6)

## 附录 · 系列文档同步（「文学风」去轴化）

| 文件 | 已改 |
|---|---|
| `design-signature-moment.md` | 「文学风衬线可复用」→ 标题衬线/mono；欢迎页字体行去掉 C7/文学风 |
| `design-tokens-debt.md` | Out of Scope「文学风字体」→ 字体/Google Fonts 策略（P1 残留表） |
| `design-style-architecture.md` | `.prose-literacy` 标为**死类随 P1 删**，不进 base.css |
| `design-doc-truth.md` | 注释文风统一与「文学风」自称清理分开，后者归 P1 T5 |
| 本文件 | S1.2 更正 + 残留表 + T5 + 决策表 |

**实现侧待改清单（写入本题，勿只改文档）**：见 S1.2 残留表与 N5/N10/N11/D2、T5。

## 决策记录（供审查）

| 决策 | 选择 | 证据 | 放弃 |
|---|---|---|---|
| 青绿是否用户可见 | **否** | `src` 无 `#00b89e` | 「被青绿污染」表述 |
| 「文学风」 | **不承认设计轴**；注释改事实、删死样式 `.prose-literacy` | 产品从未定过；TSX 0 引用 | 保留成「内容层设计轴」 |
| 双 accent 渐变（**1.2 已拍板 = A 全禁**） | **品牌面全部禁用，改实心**（新建钮/头像/发送钮/BrandMark 四处含欢迎页） | V1–V4 vs tokens「无 glow/quiet」；顶栏与欢迎页双面孔 | B/C/D（留一处渐变）——已否决 |
| `--glow-*` 改名 | **归 P2（1.5 = A 已拍板）** | 值已是 shadow；属命名债 | 本题顺手改（已否决） |
| `tokens/aurora.json` 文件名 | **保留（1.3 = A 已拍板）** | sync/build/文档连锁 | 本轮改名（已否决） |
| soft ring | **允许（1.4 = A 已拍板）** | a11y 焦点；`0 0 0 Npx` 无 blur | 当 glow 删（已否决） |
| 门禁扩权 | **本题不扩** | 另项；见 P5 机制 | 身份 PR 里加渐变扫描 |
