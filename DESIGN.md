---
design_tokens:
  name: Aurora Design Tokens
  version: 1.1.0
  source: tokens/aurora.json（Style Dictionary，生成 src/renderer/styles/tokens.css）
  themes: [light, dark]
  mechanism: css-variables
  last_synced: 2026-08-27
---

# DESIGN.md — Aurora 设计令牌契约

> 机器可读的设计系统契约（供 design-md-review / design-debt-review 类工具接入）。
> **单一真源：`tokens/aurora.json`**（Style Dictionary 构建，`pnpm tokens:build` 生成 `src/renderer/styles/tokens.css`；改令牌只改 aurora.json，禁止手改生成物）。

> 🔒 工程化强制：pnpm check:tokens（扫描裸色/dark:/space-*/w+h 双写/hex/裸 z-*，pre-push + CI 卡关）

## 1. 令牌分组总览

| 分组 | 前缀/模式 | 示例 | 说明 |
|---|---|---|---|
| 布局尺寸 | `--sidebar-w` / `--right-panel-w` / `--resizer-w` / `--drawer-w` / `--topbar-h` | `clamp(200px,17vw,280px)` | 面板宽高，clamp 响应式 |
| z-index 层级 | `--z-base:1` / `--z-surface:2` / `--z-popover:50` / `--z-modal:100` / `--z-toast:110` / `--z-boundary:999` | `z-(--z-popover)` | 6 档浮层体系，禁止裸 z-* 数字（check-tokens bare-z-index 卡关） |
| 字体 | `--font-mono/sans/serif` | `--font-mono: "JetBrains Mono", …` | 等宽/无衬线/衬线三族 |
| 字号 | `--font-size-2xs:10px` … `--font-size-lg:16px` | 6 级阶梯 | `text-xs` 等 Tailwind 类映射 |
| 圆角 | `--radius:8px` + `--radius-sm/md/lg/xl` 派生（6/8/10/12px） | `rounded-md` | shadcn 圆角映射 |
| 背景层级 | `--bg` / `--bg-elev` / `--bg-elev-2/3` | L0 页面底 → L3 悬浮态 | 3 层背景深度，双主题 |
| shadcn 语义映射 | `--background/--foreground/--card/--popover/--muted/--accent/--destructive/--border/--ring/--input` 等 | `--muted: var(--bg-elev-2)` | 与 shadcn 标准语义对齐，双主题自适应 |
| 品牌/强调 | `--accent`（紫 `#4B3FE3` / 暗 `#6A6FFF`）+ `--accent-2`（蓝）+ 派生 `--accent-dim/soft/glow` | `--accent-glow: rgba(75,63,227,.08)` | 双 accent 体系 |
| 状态色（三层架构） | 基色 `--error/--success/--amber/--magenta` · 文本层 `--error-text/--success-text/--warn-text/--accent-text` · 实底层 `--error-emphasis/--success-emphasis` | `text-error-text` / `bg-error-emphasis` | WCAG AA 文本安全层与按钮实底层分离（详见 §3） |
| 主按钮 | `--primary`（暗 `#5D62FF`） | `bg-primary text-primary-foreground` | 按钮实底与品牌强调职责分离 |
| 图表色 | `--chart-1..5` | `--chart-3: var(--amber)` | 图表系列（引用语义色） |
| 消息气泡 | `--msg-bubble-user/assistant` | `--msg-bubble-user: #F5F5F5` | 聊天气泡双主题 |
| 遮罩/玻璃 | `--overlay-bg/--overlay-blur/--drawer-overlay/--glass-bg` | `--overlay-blur: 8px` | 模态遮罩 |
| 滚动条 | `--scrollbar-thumb(-hover)` | 双主题 | 滚动条令牌 |
| 阴影 | `--shadow-elev/modal/dropdown/card(-hover)` | 中性阴影 | TraeWork 无 glow，柔和阴影体系 |
| 动效 | `--ease-soft/paper/out` + tw-animate-css | — | 缓动曲线与动画关键帧 |
| 终端 | `--terminal-selection` | `rgba(115,115,115,.30)` | xterm 选区色（禁用 --border 的 0.12） |

## 2. 双主题机制

- 两套定义：`:root`（Aurora Light）+ `.dark`（Aurora Dark），通过 `documentElement.classList` 切换（ThemeProvider）
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
5. 浮层层级一律引用 `z-(--z-*)` 令牌（check-tokens bare-z-index 卡关）

## 5. 审计接入

- `design-debt-review`：扫描硬编码颜色/任意 Tailwind 值/px 魔法数字对照本契约
- `design-md-review`：本文件 + globals.css 一致性（token 增删同步更新本文件）
- `check:tokens`：裸色/dark:/space-*/w+h 双写/hex/裸 z-* 全量卡关（pre-push + CI）
