---
design_tokens:
  name: TraeWork Design Tokens
  version: 1.2.0
  source: tokens/aurora.json（Style Dictionary，生成 src/renderer/styles/tokens.css；文件名为历史名，内容为 TraeWork）
  themes: [light, dark]
  mechanism: css-variables
  last_synced: 2026-10-09
---

# DESIGN.md — TraeWork 设计令牌契约

> 机器可读的设计系统契约（供 design-md-review / design-debt-review 类工具接入）。
> **单一真源：`tokens/aurora.json`**（Style Dictionary 构建，`pnpm tokens:build` 生成 `src/renderer/styles/tokens.css`；改令牌只改 aurora.json，禁止手改生成物）。
> **设计系统名：TraeWork**（历史名 Aurora / 「文学风」不得当作现行设计体系；见 `docs/compose/spec/design-identity.md`）。

> 🔒 工程化强制：pnpm check:tokens（扫描裸色/dark:/space-*/w+h 双写/hex/裸 z-*/文字层/字体栈 CJK 回退，CI 卡关）

## 0. 身份宪法（TraeWork quiet）

| 条 | 规则 |
|---|---|
| C1 | 表面 quiet：无默认品牌渐变、无彩色 blur 发光、无默认噪点 |
| C2 | 品牌色稀缺：紫 accent 仅用于主操作/选中/焦点/关键状态 |
| C3 | 品牌面实心：CTA/头像/BrandMark 用 `--primary`/`--accent` 实底，禁止 `accent→accent-2` 渐变填充 |
| C4 | 阴影中性：elevation 用 shadow 语义；焦点允许 `0 0 0 Npx` soft ring；禁止 `0 0 Npx` 彩色 glow |
| C5 | 状态用色层（`-*-text` / `*-emphasis` / `*-soft`），不用 blur 发光强调 |
| C6 | 命名诚实：注释/文档不把 Aurora 或「文学风」写成现行设计轴 |

## 1. 令牌分组总览

| 分组 | 前缀/模式 | 示例 | 说明 |
|---|---|---|---|
| 布局尺寸 | `--sidebar-w` / `--right-panel-w` / `--resizer-w` / `--drawer-w` / `--topbar-h` / `--content-w:820px` / `--content-w-narrow:720px` | `clamp(200px,17vw,280px)` | 面板宽高，clamp 响应式；content-w 是聊天内容列最大宽（此前魔法数散写） |
| z-index 层级 | `--z-base:1` / `--z-surface:2` / `--z-raised:10` / `--z-popover:50` / `--z-modal:100` / `--z-toast:110` / `--z-boundary:999` | `z-(--z-popover)` | 7 档浮层体系，禁止裸 z-* 数字（check-tokens bare-z-index + css-z-index-literal 双侧卡关） |
| 字体 | `--font-mono/sans/serif` | `--font-mono: "JetBrains Mono", …, "Noto Sans SC", "Microsoft YaHei", monospace` | 等宽/无衬线/标题三族（策略详见 §1.1） |
| 字号 | `--font-size-2xs:10px` … `--font-size-3xl:28px` | 9 级唯一阶梯 | `text-*` Tailwind 映射经 var 桥接单源化（base.css @theme 引用 --font-size-*，改令牌传导）；font-size-literal 卡关 |
| 圆角 | `--radius:8px` + `--radius-sm/md/lg/xl` 派生（6/8/10/12px） | `rounded-md` | shadcn 圆角映射 |
| 背景层级 | `--bg` / `--bg-elev` / `--bg-elev-2/3` | L0 页面底 → L3 悬浮态 | 3 层背景深度，双主题 |
| shadcn 语义映射 | `--background/--foreground/--card/--popover/--muted/--accent/--destructive/--border/--ring/--input` 等 | `--muted: var(--bg-elev-2)` | 与 shadcn 标准语义对齐，双主题自适应 |
| 品牌/强调 | `--accent`（紫 `#4B3FE3` / 暗 `#6A6FFF`）+ `--accent-2`（蓝）+ 派生 `--accent-dim/soft/glow` | `--accent-glow: rgba(75,63,227,.08)` | 双 accent 体系 |
| 状态色（三层架构） | 基色 `--error/--success/--amber/--magenta` · 文本层 `--error-text/--success-text/--warn-text/--accent-text/--accent-2-text` · 实底层 `--error-emphasis/--success-emphasis` | `text-error-text` / `bg-error-emphasis` | WCAG AA 文本安全层与按钮实底层分离（详见 §3）；accent-2-text 补齐 accent-2 的文字层（基色 3.49:1 不达标） |
| 主按钮 | `--primary`（暗 `#5D62FF`） | `bg-primary text-primary-foreground` | 按钮实底与品牌强调职责分离 |
| 图表色 | `--chart-1..5` | `--chart-3: var(--amber)` | 图表系列（引用语义色） |
| 消息气泡 | `--msg-bubble-user/assistant` | `--msg-bubble-user: #F5F5F5` | 聊天气泡双主题 |
| 遮罩/玻璃 | `--overlay-bg/--overlay-blur/--drawer-overlay/--glass-bg` | `--overlay-blur: 8px` | 模态遮罩 |
| 滚动条 | `--scrollbar-thumb(-hover)` | 双主题 | 滚动条令牌 |
| 阴影 | `--shadow-elev/modal/dropdown/card(-hover)` | 中性阴影 | TraeWork 无 glow，柔和阴影体系 |
| 动效 | `--ease-soft/paper/out` + `--duration-fast/state/reveal`（120/200/300ms）+ tw-animate-css | `var(--duration-fast)` | 缓动曲线 + 时长三档与动画关键帧（时长此前散写 7 种已收敛） |
| 终端 | `--terminal-selection` | `rgba(115,115,115,.30)` | xterm 选区色（禁用 --border 的 0.12） |

### 1.1 字体策略（2026-10-09 同步）

- **三栈 CJK 回退不变量**：`--font-sans/--font-serif/--font-mono` 栈内必须含 CJK
  回退——Windows mono 上下文缺回退时中文掉 SimSun 宋体，小字 ClearType 下发灰
  发绿（文件树与 xterm 终端先后实测）；硬编码 `font-family`/`fontFamily` 必须引用
  `var(--font-*)` 或自带 CJK 回退，`font-cjk-fallback` 规则 CSS/TS 双侧卡关，
  CJK 白名单刻意不含 SimSun（它是本不变量要防的失败形态本身）。
- **webfont**：Google Fonts 运行时加载 JetBrains Mono + Noto Sans SC（后者是 mono
  栈的 CJK 回退）；加载失败降级栈内系统字体（PingFang SC / Microsoft YaHei /
  Consolas），离线可用性由回退链兜底。未自托管（@font-face 零）——完全离线的
  字体一致性与首载体积的取舍未拍板。
- **--font-serif 名实**：历史名，实为 SF Pro sans 栈、用于标题（非衬线）；改名是
  breaking（63 处消费 + e2e `.font-serif` 选择器），保持现名、此处如实登记。
- **其余字体轴**：font-weight / letter-spacing 走 Tailwind 标准工具类（font-bold /
  tracking-*），未令牌化——标准 Tailwind 用法，非缺口；终端 lineHeight 为 xterm
  单值（1.3），settings 仅 fontSize 档位（36 号），lineHeight 档位化留待需要时。
- **settings 无 fontFamily 自定义面**（终端/编辑器仅 fontSize 档位）：有意——防
  用户配置缺 CJK 回退的栈复发掉宋体问题。

## 2. 双主题机制

- 两套定义：`:root`（TraeWork Light）+ `.dark`（TraeWork Dark），通过 `documentElement.classList` 切换（ThemeProvider）
- **派生色规则**：每个语义色族 = 主色 + 可选 `-dim`（深）/`-soft`（半透明底）/`-glow`（光晕），双主题各自定义
- **禁止**：组件内 `dark:` 手动覆盖（10-component-design-spec 铁律 ②）；裸 Tailwind 色板值（铁律 ①）

## 3. 语义色三层架构（2026-08 WCAG 根治轮）

单一颜色 token 无法同时满足「暗底文字要亮」与「白字按钮底要深」（对比度约束不相交），因此语义色拆三层：

| 层 | 令牌 | 用途 | 对比度要求 |
|---|---|---|---|
| 基色 | `--accent/--error/--success/--amber` | 图形/边框/软底/图标 | ≥3:1 |
| **-text 层** | `--accent-text/--error-text/--success-text/--warn-text` | 彩色**文字**（亮色取深档、暗色取亮档） | ≥4.5:1 |
| **-emphasis 层** | `--error-emphasis/--success-emphasis` | 实底按钮 + 白字（双主题同值锁定） | 白字 ≥4.5:1 |

规则：新增彩色文字一律用 `text-xxx-text` 类；实底彩按钮前景恒 `text-primary-foreground`/`text-destructive-foreground`；`--primary`（暗 `#5D62FF`）专供按钮实底，与 `--accent`（文本/图形）职责分离。

## 4. 使用规则

1. 颜色/字体/间距必须引用令牌：`bg-[var(--accent)]` / `text-muted-foreground` / `text-[var(--error)]`
2. 引用 CSS 变量一律 `var(--x)`；Tailwind 语义类（`bg-muted`/`text-foreground`）由 @theme inline 映射自动指向令牌
3. 新增令牌必须双主题成对添加，且满足 WCAG 对比度门槛（11-a11y-spec §1.1）
4. 删除/改名令牌必须同步搜索 `var(--x)` 引用（设计债审计会检查孤儿令牌）
5. 浮层层级一律引用 `z-(--z-*)` 令牌（check-tokens bare-z-index 卡关）；CSS 侧同理（css-z-index-literal 卡关）

## 5. 审计接入

- `design-debt-review`：扫描硬编码颜色/任意 Tailwind 值/px 魔法数字对照本契约
- `design-md-review`：本文件 + `styles/tokens.css`/`styles/*` 一致性（token 增删同步更新本文件）
- `check:tokens`：裸色/dark:/space-*/w+h 双写/hex/裸 z-*/文字层/字体栈 CJK 回退（含 font 简写与任意值字体）全量卡关（CI）
