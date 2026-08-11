---
design_tokens:
  name: Aurora Design Tokens
  version: 1.0.0
  source: src/renderer/styles/globals.css
  themes: [light, dark]
  mechanism: css-variables
  last_synced: 2026-08-11
---

# DESIGN.md — Aurora 设计令牌契约

> 机器可读的设计系统契约（供 design-md-review / design-debt-review 类工具接入）。
> **单一真源：`src/renderer/styles/globals.css`**（本文件为契约摘要，值以 globals.css 为准，同步时以 globals.css 为准覆盖本文件）。

> 🔒 工程化强制：pnpm check:tokens（扫描裸色/dark:/space-*/w+h 双写/hex，pre-push + CI 卡关）

## 1. 令牌分组总览

| 分组 | 前缀/模式 | 示例 | 说明 |
|---|---|---|---|
| 布局尺寸 | `--sidebar-w` / `--right-panel-w` / `--resizer-w` / `--drawer-w` / `--topbar-h` | `clamp(200px,17vw,280px)` | 面板宽高，clamp 响应式 |
| z-index 层级 | `--z-*` | `--z-modal: 2000` / `--z-toast: 10000` / `--z-boundary: 30000` | 从低到高 15 档，全组件统一 |
| 字体 | `--font-mono/sans/serif`（`--mono/sans/serif` 别名） | `--font-mono: "JetBrains Mono", …` | 对齐原型 --mono/--sans/--serif |
| 字号 | `--font-size-*` | `--font-size-2xs: 10px` … `--font-size-lg: 16px` | 6 级字号阶梯 |
| 圆角 | `--radius-*` | `--radius: 0.625rem` (10px) | 基础圆角 10px |
| 背景层级 | `--bg` / `--bg-elev` / `--bg-elev-2/3`（`--bg-elev-4` 已废弃，别名指向 3） | L0 页面底 → L3 悬浮态 | 3 层背景深度 |
| shadcn 语义映射 | `--background/--foreground/--card/--popover/--muted/--accent/--destructive/--border/--ring/--input` 等 | `--muted: …` | 与 shadcn 标准语义对齐，双主题自适应 |
| 品牌/强调 | `--accent`（绿松石）+ `--accent-2`（蓝）+ 派生 `--accent-dim/soft/glow` | `--accent-2: #2b7fff` / `#4a9eff` | 双 accent 体系（对齐参考项目） |
| 状态色 | `--success/--error/--warn/--amber(+dim/glow)/--magenta/--info-blue/--error-bg` | `--error: #c53030` / `#ff6b6b` | 语义状态，双主题各保证对比度 |
| 图表色 | `--chart-1..5` | `--chart-3: var(--amber)` | 图表系列（引用语义色） |
| 消息气泡 | `--msg-bubble-user/assistant` + `--user-bubble` 别名 | `--msg-bubble-user: #1a2332` | 聊天气泡双主题 |
| 遮罩/玻璃 | `--overlay-bg/--overlay-blur/--drawer-overlay` | `--overlay-blur: 8px` | 模态遮罩 |
| 动画 | `animate-*` 类（tw-animate-css） | — | 动画关键帧与时长 |
| 滚动条 | `--scrollbar-*` | — | 双主题滚动条 |
| 特效 | `--grid-line/--scan-line/--noise` 等 | — | 背景纹理 |

## 2. 双主题机制

- 两套定义：`:root`（Aurora Light）+ `:root.dark`（Aurora Dark），通过 `documentElement.classList` 切换（ThemeProvider）
- **派生色规则**：每个语义色族 = 主色 + 可选 `-dim`（深）/`-soft`（半透明底）/`-glow`（光晕），双主题各自定义
- **禁止**：组件内 `dark:` 手动覆盖（10-component-design-spec 铁律 ②）；裸 Tailwind 色板值（铁律 ①）

## 3. 使用规则

1. 颜色/字体/间距必须引用令牌：`bg-[var(--accent)]` / `text-muted-foreground` / `text-[var(--error)]`
2. 引用 CSS 变量一律 `var(--x)`；Tailwind 语义类（`bg-muted`/`text-foreground`）由 shadcn 映射自动指向令牌
3. 新增令牌必须双主题成对添加，且满足 WCAG 对比度门槛（11-a11y-spec §1.1）
4. 删除/改名令牌必须同步搜索 `var(--x)` 引用（设计债审计会检查孤儿令牌）

## 4. 审计接入

- `design-debt-review`：扫描硬编码颜色/任意 Tailwind 值/px 魔法数字对照本契约
- `design-md-review`：本文件 + globals.css 一致性（token 增删同步更新本文件）
