---
feature: design-tokens-debt
status: designed
updated: 2026-09-26
branch: (pending)
commits:
---

# 问题 2 · 令牌债收敛

> 系列：一个问题 · 一份方案 · 一个文档，路径 `docs/compose/spec/`。
> **范围**：字号双轨、死键/假别名、阴影名实不符、圆角魔法数。**不含** `--aurora-*` 身份改名（P1）、`globals.css` 拆文件（P3）、签名视觉（P4）。
>
> **核实方式**（2026-09-26，只读）：全文读 `tokens/aurora.json`（604 行）；对照 `tokens.css` 生成物；对 `src/**/*.{ts,tsx,css}` 做 `var(--…)` 全量计数（PowerShell Group-Object）；逐键确认零引用。下文「0 消费」均经 `rg var(--键)` 无命中（定义/`@theme` 注册除外）。

## Report

## [S1] Problem

### S1.1 一句话

`aurora.json` 约 **100+ 键**里混着：**两套同名不同义字号**、一批**注释撒谎的别名**、一批**从未被引用的死键**，以及 **glow/shadow 双轨阴影**——贡献者无法判断「用哪个、删了会不会炸」。

### S1.2 证据 A · 字号三通道 + 同名对调（最危险）

**真源两套（`aurora.json`）**

| 设计阶梯 `font-size-*` | 值 | 旧轨 `fs-*` | 值 | 问题 |
|---|---|---|---|---|
| 2xs / xs / sm | 10 / 11 / 12 | 同 | 同 | 重复定义 |
| **base** | **13px** | **base** | **14px** | **同名不同值** |
| **md** | **14px** | **md** | **13px** | **同名对调** |
| lg | 16px | lg | 16px | 重复 |
| —（无） | — | xl / 2xl / 3xl | 18 / 22 / 28 | **仅旧轨** |

注释写「旧字号别名（兼容已有组件代码）」（`aurora.json:447`）——**base/md 并非别名，是错位两套数**。机械 `fs-base`→`font-size-base` 会把 14px 正文改成 13px。

**第三通道 Tailwind**（`globals.css:42-52` `@theme inline` 内联 10/11/12/13/14/16，与 `font-size-*` 同数）。

**消费（已核实）**

| 通道 | 位置 | 量 |
|---|---|---|
| `var(--fs-*)` | **仅** `globals.css` | **12** 处：`fs-base`×5（163,1694,2128,3561,4154）、`fs-sm`×4、`fs-xs`×2、`fs-3xl`×1（1115 欢迎页 28px） |
| `var(--font-size-*)` | 仅 globals | 多处（`font-size-sm` 17 次等） |
| TSX `text-2xs…lg` | **70+** 文件 | 大量（settings/about、approval-preview 等） |

**注释失实**：`globals.css:46` 写「`fs-base=15px` 与设计 13px 冲突」——真源 `fs-base` 已是 **14px**。

### S1.3 证据 B · 死键（定义在、全仓 0 业务消费）

| 键 | 定义处 | 消费 |
|---|---|---|
| `--danger` | 556–558 | **0** |
| `--bg-primary` | 546–549 | **0** |
| `--text-primary` | 550–552 | **0** |
| `--bg-ter` | 553–555 | **0** |
| `--glow-lg` | 243–246 | **0** |
| `--glow-2-sm` | 247–250 | **0** |
| `--glow-2-md` | 251–254 | **0** |
| `--bg-elev-4` | 91–94 | 仅 `@theme` `--color-bg-elev-4` 注册（globals:121），无 `bg-elev-4` 业务类 |
| **`--sp-1…7`** | 473–494 | **0**（`var(--sp-` 全仓无命中） |
| **`--icon-xs…xl`** | 530–545 | **0** |
| **`--shadow-elev`** | 495–499 | **0** |
| `--grid-line` / `--scan-line` / `--noise-opacity` / `--noise-blend` | 255–271 | 纹理已关（值 transparent/0）；若无 `var()` 消费可标 deprecated 归档 |

> 死键不止「兼容层」四五个，**间距/图标整阶梯未接入消费通道**——这是「令牌建了但没用」的结构性债。

### S1.4 证据 C · 假别名与仍用别名

| 键 | 注释声称 | 实测 |
|---|---|---|
| `--text-dim` | 「兼容别名 — **指向** --text-secondary」 | **独立色值**复制 `#404040`/`#D4D4D4`，**不是** `var(--text-secondary)`；globals **15** 次 `var(--text-dim)` vs **1** 次 `var(--text-secondary)` |
| `--user-bubble` | 兼容别名 | 真 `var(--msg-bubble-user)`；globals **1** 处（1701 气泡） |
| `--warn` | `var(--amber)` | `file-icon.tsx:43` + 测试；`@theme` 有 `--color-warn`。另有 `remote-web-client.ts` **独立作用域** `--warn` 勿合并 |
| `--warning` | `var(--amber)` | globals 3–4 处真实使用（合法别名，可保留或并入 amber 语义层） |
| `--shadow-pop` | 「扩展阴影（兼容）」 | 真 `var(--shadow-dropdown)`；globals 2 处 |

### S1.5 证据 D · 阴影双轨（名实不符 + 主消费走错名）

| 系列 | 语义（值） | globals `box-shadow`/引用 |
|---|---|---|
| `--glow-sm/md` | **中性 elevation**（注释已写「替代发光」） | **15**（glow-sm）+ **3**（glow-md）≈18 |
| `--shadow-card/-hover/-pop/-dropdown/-modal` | 同类 elevation | 合计约 **8** |
| `--shadow-elev` | 同类 | **0** |

「glow」名继续误导（P1 还要删彩色 `0 0 Npx` glow 语法，更易混）。

### S1.6 证据 E · 圆角魔法数

| 体系 | 真源 | 消费 |
|---|---|---|
| `--radius: 8px` → `@theme` sm/md/lg/xl（6/8/10/12） | `aurora.json:67-70` + globals 55–58 | TSX `rounded-*` 广泛 |
| 硬编码 | `border-radius: Npx` | **globals.css 约 80** 处（1/2/3/4/5/6/7/8/10/12/14/20px…） |

### S1.7 门禁边界

`check:tokens`：裸色/dark:/space-*/w+h/hex/rgb/裸 z-*。  
`check:css-vars`：悬空 `var()`。  
**均不拦**：双轨字号、死键、假 `var()` 别名、glow 命名、`border-radius` 魔法数、`--sp-*` 零消费。

### S1.8 根因

1. 迁移只**加** `font-size-*` 未**删/对齐** `fs-*`，且 base/md 语义错位。
2. 兼容别名无退役：死键不清；`text-dim` 用复制值假称 alias。
3. 阴影改「值为中性」未改名、未迁主消费。
4. 间距/图标令牌写入真源但未接 Tailwind/`var()` 消费。
5. 圆角只收了 Tailwind 层。

## [S2] Design

### S2.0 目标状态

```
aurora.json 唯一字号阶梯（9 级，含 xl/2xl/3xl 升格）
  font-size-2xs…3xl = 10,11,12,13,14,16,18,22,28
        ↓ tokens:build
tokens.css --font-size-*
        ↓ @theme（与阶梯同数；可 var() 引用以消第三份拷贝）
Tailwind text-*
```

| 语义名 | 终态 px | 用途（保持现密度） |
|---|---|---|
| 2xs / xs / sm | 10 / 11 / 12 | 角标 / 元信息 / 辅助 |
| base | **13** | UI 正文 |
| md | **14** | **对话正文、输入框**（现 `--fs-base` 语义） |
| lg / xl / 2xl / 3xl | 16 / 18 / 22 / 28 | 标题至欢迎页品牌字 |

**铁律（2.1 = A 已拍板）：只统一命名，不改像素。** 还债 ≠ 重新排版。

### S2.1 字号映射（2.2 = A 已拍板：强制按值迁，禁止名对名）

| 旧引用 | 值 | **正确**目标 | 错误目标（禁止） |
|---|---|---|---|
| `--fs-base` | 14 | `--font-size-md` | `--font-size-base`（会变 13） |
| `--fs-md` | 13 | `--font-size-base` | `--font-size-md`（会变 14） |
| `--fs-sm/xs/2xs/lg` | 12/11/10/16 | 同名 `font-size-*` | — |
| `--fs-xl/2xl/3xl` | 18/22/28 | 新注册 `font-size-xl/2xl/3xl` | 丢弃导致欢迎页无 28px |

12 处 CSS 逐点改完；TSX `text-*` **像素不动**。同步删 `globals.css:46`「fs-base=15px」假句。

### S2.2 键退役表

| 动作 | 键 | 条件 |
|---|---|---|
| **删** | `danger` `bg-primary` `text-primary` `bg-ter` `glow-lg` `glow-2-sm` `glow-2-md` `bg-elev-4`（含 @theme 注册） | 删前再 `rg` 确认 0 消费 |
| **删或正式接线** | `sp-1…7` `icon-xs…xl` | 若 P3/组件不用间距令牌：**删**并在 DESIGN 记「间距走 Tailwind space/gap」；若要用：必须进 `@theme` 且出现真实 `var(--sp-*)` |
| **删** | `shadow-elev`（0 消费）或接到浮动层 | 默认删 |
| **合并** | `text-dim` → `text-secondary` | 15 处改名；删独立定义与 `--color-text-dim`（若有 Tailwind `text-dim` 一并改） |
| **合并** | `user-bubble` → `msg-bubble-user` | 1 处 |
| **改引用** | `warn` → `amber`（应用侧） | `file-icon.tsx`+测试；不动 remote-web-client |
| **保留** | `warning`（=amber 别名） | 有 3+ 消费；可留一层语义 |
| **归 P1** | `aurora-*` 12 键 | `design-identity.md` |
| **改名迁移** | `glow-sm/md` → `shadow-soft` / `shadow-raise`（名可再定） | 见 S2.3 |

### S2.3 阴影（1.5 已拍板 = 归本题；本题内采用方案 A 改名）

**A（已选方向）**：`glow-sm`→`shadow-soft`，`glow-md`→`shadow-raise`；迁移 globals ≈18 处 + `fuzzy-search-dialog` 等；删 glow 键。与 `shadow-card/pop/modal` 形成单一 `shadow-*` 家族。

**B**：保留 glow 名，comment 标「历史名，语义 shadow」；债进 `debt.md`。

与 P1 关系：P1 清的是 **彩色 `0 0 Npx` 发光语法**；本题清的是 **令牌命名**。可顺序做，勿混在一个 diff 语义里。

### S2.4 圆角（2.6 = B 已拍板：全量迁到令牌，接受像素微调）

- **B（已选）**：`globals.css` 约 80 处 `border-radius: Npx` **全部**改为 `var(--radius)` 派生（`--radius-sm/md/lg/xl`）或 `rounded-full`/`50%` 点状。
- 映射：2–4px 小件 → `--radius` 减算或最近档；6–8px 控件 → sm|md；10–14px 卡片 → lg|xl；`50%` 保留。
- **接受**：visual 可能有 1–2px 级 diff；PR 需附「圆角令牌化」说明与截图对比。
- 与 2.1「不改字号像素」不冲突：2.1 管**字号**；2.6 管**圆角**，用户已选 B。
- 门禁：迁完后 `globals.css` **禁止**新增裸 `border-radius: <px>`（可作棘轮锁 0）。

### S2.5 生成物纪律

只改 `aurora.json` → `pnpm tokens:build` → `pnpm tokens:check` 绿。`DESIGN.md` 字号表改 9 级唯一阶梯，删除「旧别名」叙事。

### S2.6 验证

| 检查 | 期望 |
|---|---|
| `rg "var\(--fs-" src` | 0 |
| `rg "var\(--danger\)\|var\(--bg-elev-4\)\|var\(--text-dim\)\|var\(--user-bubble\)" src` | 0 |
| `rg "glow-lg\|glow-2-\|var\(--sp-\|var\(--icon-" src` | 0（若选择删 sp/icon） |
| `pnpm tokens:check` `check:tokens` `check:css-vars` `check:static` | 绿 |
| `pnpm test:renderer` `test:visual` | 绿；visual **应零像素 diff**（保密度） |

人工：消息正文观感仍 14px；欢迎页大字仍 28px；meta 仍 11–12px。

## [S3] Out of Scope

- `--aurora-*` → P1；CSS 拆分 → P3；签名 → P4
- 字号像素重设计；字体族/Google Fonts 策略（含 Noto Serif，见 P1 残留表）；remote-web `--warn`
- 间距体系「该不该用 sp-*」的产品决策（表内给两选项，实现时二选一并记录）

## Tasks

- [ ] T1: 字号 9 级唯一 + 删 `fs-*` — acceptance: xl/2xl/3xl 入真源；tokens:build/check 绿 (covers: S2.0)
- [ ] T2: 12 处 `--fs-*` 按映射迁移 — acceptance: 无 `var(--fs-`；base↔md 不得对调错误；visual 零 diff (covers: S2.1; depends: T1)
- [ ] T3: 删死键（含 sp/icon/shadow-elev 决策落地） — acceptance: 表 B 全清或 sp/icon 明确接线；0 悬空 (covers: S2.2; depends: T1)
- [ ] T4: text-dim / user-bubble / warn 合并 — acceptance: 15+1+应用侧 warn 改完；假「指向」注释删除 (covers: S2.2; depends: T3)
- [ ] T5: 阴影改名迁移（方案 A） — acceptance: 单一 shadow 族；glow 键删除 (covers: S2.3; depends: T3)
- [ ] T6: 圆角全量令牌化（2.6=B） — acceptance: globals 无裸 `border-radius: px`（点状 50% 除外）；映射表执行；visual diff 仅圆角且已说明 (covers: S2.4)
- [ ] T7: DESIGN.md + 全量验证 — acceptance: 9 级表；S2.6 全绿并记录 (covers: S2.5, S2.6; depends: T2, T4, T5)

## 决策记录（供审查）

| 决策 | 选择 | 依据 | 放弃 |
|---|---|---|---|
| 像素 | **保持现密度（2.1 = A 已拍板）** | 还债≠重设计 | 正文统一 13px（已否决） |
| base/md | **fs-base→font-size-md（2.2 = A 已拍板，按值）** | 真源值+正文用法 | 名对名替换（会改像素） |
| 死键 | **删（2.3 = A）含 sp/icon/shadow-elev** | 0 消费已核 | 「以防万一」/ sp-icon 闲置 |
| sp/icon | **删除（2.3 = A 已拍板）** | 已实测 0 var() | 接线或永久闲置（均否决） |
| text-dim | **删→secondary（2.4 = A）** | 假 alias+15 处 | 修成 var() 再留（否决） |
| glow 命名 | **归本题改名（1.5 = A）；实现走方案 A shadow** | P1 不顺手改；18 vs 8 消费 | P1 混做 / 只改注释 B（否决） |
| 圆角 | **全量 var(--radius-*)（2.6 = B 已拍板）** | 用户选择体系干净 | 棘轮+触碰改（否决） |
