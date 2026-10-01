---
feature: design-style-architecture
status: delivered
updated: 2026-09-26
branch: feat/design-identity
commits: 2059fcd..ca3c8f8
---

# 问题 3 · 样式双轨收敛（`globals.css` 可维护性）

> 系列：一个问题 · 一份方案 · 一个文档，路径 `docs/compose/spec/`。
> **范围**：样式文件职责、拆分边界、utility vs 领域类的决策表、体积棘轮。**不含**身份视觉（P1）、令牌键名/字号（P2）、签名新视觉（P4）。
>
> **核实方式**（2026-09-26，只读）：`index.css` 全文；`globals.css` 行数/`@`/分节注释全表；`check-file-size.baseline.json` + `limits.json`；`ui-consistency-rules.ts`（raw-button / OWNED_CSS_BUTTON_CLASSES）；TSX `className` 抽样（message-item / ChatInput / Sidebar / tool-call-view）；`loading-ui/terminal.tsx` 关键帧约定注释。

## Report

**What was built** — `globals.css` 按域拆为 base/layout/welcome/chat/composer/cards/file-tree/fuzzy/motion + 入口 `styles/index.css`（3.2=B）；keyframes 收拢 `motion.css`；删除 net 3416 特例基线；新样式决策表写入组件规范。

**Verification** — `check:file-size`（新域 ≤600 net）/ `check:animations` / `check:css-vars` / `typecheck` 绿；TSX 结构类名未改。

**Journey log** — ① 拆分只在注释外切开，否则截断注释；② 入口改名必须扫「见 globals.css」路径字符串；③ panels 超 600 再拆子域。


## [S1] Problem

### S1.1 准确表述

不是「Tailwind 用错了」，而是：

1. **一条 4227 行的领域样式巨石**承载几乎全部复杂皮肤；
2. **两套类名体系并行**（Tailwind utility + BEM 域名类），边界只靠零散注释；
3. **体积门禁为它单独开洞**，通用 600 净行规则失效；
4. **约定与实现有小漂移**（keyframes「统一在 globals」但 `index.css` 仍有 1 组；注释写「15 个 keyframes」实测约 18+）。

### S1.2 证据 A · 文件与入口（已核实）

| 项 | 数值/事实 |
|---|---|
| `src/renderer/index.css` | **30** 行：`@import tailwindcss` + `tw-animate-css` + `./styles/globals.css` + `@custom-variant dark` + `.search-highlight` + **1 组 `@keyframes search-highlight-fade`** |
| `styles/globals.css` | **4227** 行；首行 `@import "./tokens.css"` |
| `styles/tokens.css` | **317** 行（生成物） |
| 唯一类选择器（globals） | **≈277** |
| `@theme inline` | 在 globals **42–147** 附近（Tailwind v4 映射 + radius 派生） |
| `@keyframes` | globals **≈18**（pulse-soft/boot-reveal/file-viewer-pulse/jump-bar-in/msgEnter/blink/typingBounce/shimmer/pulseDot/refreshing-slide/browser-loading-bar/fadein/modalin/toolSpin/toolExpand/reasoningReveal/pulse-check/runningBar）+ index **1** |
| `prefers-reduced-motion` | **两处**：globals **1609** 与 **4040**（4040 覆盖动画选择器清单，见 4041–4052） |
| 源码注释引用 `globals.css` | 至少 8 个文件（transitions/terminal/DevPanel/browser-pane/Markdown/message-actions/fuzzy-search-dialog/loading-ui） |

### S1.3 证据 B · 体积棘轮开洞

| 来源 | 内容 |
|---|---|
| `scripts/limits.json` | `fileSize.net = 600`（唯一卡关口径）、`raw = 600`（仅告警） |
| `scripts/check-file-size.baseline.json` | **仅 4 条**超限登记：`definitions.ts` net 975、`agent-service.ts` 683、`mock-api.ts` 948、**`globals.css` net 3416** |

即：globals 以 **5.7×** 通用净行上限常驻基线；后续只要不超过 3416 就不会被 file-size 拦住，**无自动刹车**。

### S1.4 证据 C · 双轨真实边界（TSX 实测混用）

```
通道 A · Tailwind utility
  flex / gap-* / size-* / text-2xs / text-muted-foreground / rounded-* / cn()
  落在 TSX；@theme 把 --text-* / --color-* 接到令牌

通道 B · 领域 BEM（globals.css）
  .sidebar* .new-thread-btn .composer-* .msg-* .card* .tool-card
  .ft-* .file-viewer-* .fuzzy-result .icon-btn .thread-item …
  同一批 TSX 的稳定结构/皮肤
```

**实测样例**

- `tool-call-view.tsx`：`msg msg-tool` + `card tool-card` + Tailwind `size-3.5 text-accent animate-spin` 叠在同一节点（88–102）。
- `Sidebar.tsx`：`sidebar` / `new-thread-btn` / `sidebar-tab` 与 `bg-accent absolute …` 并存（273–306）。
- `ChatInput.tsx`：`composer-box` / `composer-input` / `composer-bar` 为主。
- `message-item.tsx`：`msg user enter-anim` + `cn('msg-body', isContinuation && 'ml-10')`。

**项目已正式承认「globals 按钮类体系」**：`ui-consistency-rules.ts:79-106` `OWNED_CSS_BUTTON_CLASSES`（26 个：`icon-btn`/`composer-tool-btn`/`card-head`/`fuzzy-result`/…），供 `raw-button` 规则豁免——说明双轨是**有意架构**，不是偶然堆砌。

### S1.5 证据 D · 分节注释已给出天然切割线（拆分不必发明模块）

`globals.css` 内既有分节（行号约，以注释为准）：

| 约行 | 分节 | 建议归宿 |
|---|---|---|
| 1–41 | import + 主题头 | entry |
| 42–329 | `@theme` + 滚动条/选区/（`.prose-literacy` **死类，随 P1 删除**）+ `pulse-soft` | entry / base |
| 368–377 | 氛围/纹理空壳（paper-texture 等） | base |
| 385–1092 | 应用骨架 / sidebar / topbar / resizer / right-panel | **layout** |
| 1094–1246 | `§welcome-mode` | **welcome** |
| 1248–1574 | `§composer-project-bar` + 启动相关 | **composer** |
| 1576–1614 | 启动动画 / 焦点环 / reduced-motion | motion / base |
| 1616–2004 | 消息流 + Markdown + shiki | **chat** |
| 2006–2303 | Composer 输入舱 | **composer** |
| 2305–2894 | 卡片系统 + 审批 Diff | **panels** |
| 2896–3578 | 空状态 / 文件树 / 文件查看器 / vim 徽章 / scanlines | **panels** |
| 3579–4055 | 骨架屏 + **全部 keyframes** + reduced-motion 总闸 | **motion** |
| 4057–4227 | fuzzy-result 等 | panels / chat |

### S1.6 证据 E · 约定漂移（小但真实）

| 约定 | 出处 | 实测 |
|---|---|---|
| 「关键帧统一在 globals.css」 | `loading-ui/terminal.tsx:13`、`terminal.test.tsx` | `index.css:23-29` 仍有 `search-highlight-fade` |
| 「globals.css 现有 **15** 个 @keyframes」 | 同上注释 | 现约 **18** 个（+ index 1）——注释略过时 |
| 「见 globals.css」 | 8+ 文件注释 | 入口名被文档/测试绑定（拆分后宜保留 `globals.css` 作入口名） |

### S1.7 门禁能/不能

| 设施 | 能 | 不能 |
|---|---|---|
| `check:file-size` | net 棘轮；globals 基线 3416 | 阻止继续接近 3416 |
| `check:ui-consistency` | 7 条 TSX 规则（key/cn/unwrap/raw-button/try-finally/queryKey/direct-ipc） | 约束「该写 utility 还是 BEM」 |
| `check:animations` | keyframes 名存在性 | 文件归属 |
| `check:tokens` / `css-vars` | 裸色 / 悬空 var | 文件结构 |

### S1.8 根因

1. 领域皮肤集中写在单一 `globals.css`，演进只增不拆。
2. utility/BEM 双轨**无成文决策表**（只有 raw-button 白名单暗示）。
3. file-size 对 CSS 巨石用「高基线」代替「拆文件」。
4. keyframes/reduced-motion 双点，注释与现实微漂。

## [S2] Design

### S2.0 目标（一句话）

**类名冻结、像素冻结、TSX 零 diff——只拆文件 + 写清「新样式写哪」+ 恢复体积棘轮。**

明确 **不做**：CSS Modules、CSS-in-JS、BEM→utility 全量改写、合并 `ui/button` 与 `icon-btn`、改视觉（P1/P4）。

### S2.1 目标结构

```
src/renderer/
├── index.css              # 入口：tailwindcss / tw-animate-css / styles/* / @custom-variant
└── styles/
    ├── tokens.css         # 生成物（P2）
    ├── globals.css        # 薄入口：@import tokens+各层 + @theme + 必要 reset
    ├── base.css           # 选区/滚动条/焦点（不含已删的 prose-literacy，见 P1）
    ├── layout.css         # app/topbar/sidebar/resizer/right-panel
    ├── welcome.css        # welcome-mode
    ├── chat.css           # .msg* / markdown / code-block
    ├── composer.css       # .composer* / project-bar
    ├── panels.css         # .card* / approval-diff / file-tree / file-viewer / empty / fuzzy-result
    └── motion.css         # 全部 @keyframes + prefers-reduced-motion 单点
```

**入口改名（3.2 = B 已拍板）**：`globals.css` 不再作为薄入口名——目标入口为 `src/renderer/styles/index.css`（或与 `renderer/index.css` 二选一，实现时定死并写进任务）。原先注释/测试里的「见 globals.css」**同 PR 批量改路径字符串**。理由：避免「globals」一名与「已拆分」状态长期名实不符。

**`@import` 顺序**（实现时必须 `pnpm exec vite build` + 浏览器实测，不得靠猜）：

- CSS 规范：`@import` 在其他 at-rule 之前；
- 若 `@theme` 必须紧随 tokens：则 `globals.css` 为 `@import tokens` → `@theme` → `@import base/layout/...` 的「合法形态」或改为在 `index.css` 统一 import 顺序；
- **验收以 Tailwind 工具类仍生成、visual 零 diff 为准。**

### S2.2 搬迁规则

1. **整块剪切**既有分节注释辖区，不重排选择器、不合并规则、不改特异性。
2. **类名零变更**；**`src/**/*.tsx` 零 diff**。
3. `index.css` 的 `search-highlight*` **迁入 motion.css**（或 chat.css，二选一写死）；`index.css` 只留 Tailwind 入口 + `@custom-variant`。
4. 两处 `prefers-reduced-motion`（1609、4040）**合并为一处**进 motion.css，选择器并集不缩水（合并前 diff 清单）。
5. `check:animations` 必须绿；`loading-ui` 测试「无组件内 keyframes」继续过。
6. 修正过时注释：keyframes 数量、「15 个」→ 与 motion.css 一致。

### S2.3 「新样式写哪」决策表（写入 10-component-design-spec 或 AGENTS）

| 场景 | 写在哪 |
|---|---|
| shadcn/Radix 变体、按钮/输入基础 | `components/ui/*` + cva |
| 布局/间距/排版微调 | TSX utility + `cn()` |
| 跨组件稳定皮肤（消息/输入舱/卡片/侧栏/文件树） | `styles/{chat,composer,panels,layout,welcome}.css` |
| 全局动画/焦点/reduced-motion | `styles/motion.css` / `base.css` |
| **禁止** | 组件内 `<style>`、新的未登记全局魔法类、第二套按钮类 |

`OWNED_CSS_BUTTON_CLASSES` 保留，注释指向本表（只服务 raw-button）。

### S2.4 体积棘轮

| 文件 | 目标 |
|---|---|
| `globals.css`（入口） | net **≤ 400** |
| `base/layout/welcome/chat/composer/panels/motion.css` | 各 net **≤ 600**（通用限额） |
| baseline | 删除 `globals.css: {net:3416}`；`--update-baseline` 收紧；**禁止**为新文件申请 >600 |

若单域超 600：优先拆子文件或压注释，**不再**抬基线。

### S2.5 验证

| 命令/检查 | 期望 |
|---|---|
| `pnpm typecheck && pnpm lint` | 绿 |
| `pnpm check:static`（file-size / animations / css-vars / ui-consistency） | 绿 |
| `pnpm test:renderer` | 绿 |
| `pnpm test:visual` | **零像素 diff** |
| `git diff --stat -- 'src/**/*.tsx'` | **空** |

人工：聊天/侧栏/设置/终端与拆分前一致。

## [S3] Out of Scope

- P1 渐变/发光/头像；P2 字号/别名；P4 工具卡签名
- utility 化 / CSS Modules / 合并两套按钮
- 主进程 / `remote-web-client` 内嵌 CSS

## Tasks

- [x] T1: 按分节整块搬迁成 styles/*.css — acceptance: 结构符合 S2.1；TSX 零 diff；visual 零像素 diff (covers: S2.1, S2.2)
- [x] T2: globals 降为薄入口 + import/@theme 顺序实测 — acceptance: net≤400；工具类仍生成 (covers: S2.1; depends: T1)
- [x] T3: keyframes + reduced-motion 单点化 — acceptance: index 无 keyframes；两处 media 合并且选择器并集不缩水；check:animations 绿；注释「15 个」修正 (covers: S2.2; depends: T1)
- [x] T4: file-size 基线收紧 — acceptance: 无 3416 特例；新文件 ≤600 (covers: S2.4; depends: T2)
- [x] T5: 新样式决策表落文档 — acceptance: 进入组件规范/AGENTS；OWNED_CSS_BUTTON_CLASSES 注释指向 (covers: S2.3; depends: T1)
- [x] T6: 全量验证 — acceptance: S2.5 全绿并记录 (covers: S2.5; depends: T3, T4)

## 决策记录（供审查）

| 决策 | 选择 | 依据 | 放弃 |
|---|---|---|---|
| 双轨（3.1=A） | **保留 utility + 领域类** | OWNED_CSS_BUTTON_CLASSES 已制度化 | 全量 utility / CSS Modules |
| 拆分 | **按域 @import，类名冻结** | 零 TSX 风险 | 每组件一 CSS |
| 入口名（3.2=**B**） | **改名 styles/index.css + 全仓改引用** | 用户要求名实一致 | 保留 globals.css 名（已否决） |
| keyframes（3.3=A） | **motion.css 单点** | 与项目约定一致 | 继续散落 |
| reduced-motion（3.3=A） | **合并两处** | 1609/4040 分裂 | 保持双点 |
| 体积（3.5=A） | **新文件 ≤600 net** | 恢复通用棘轮 | 再开 3000+ 基线 |
| 验收（3.4=A） | **TSX 零 diff + visual 零 diff** | 还债不改像素 | 顺手美化 |
