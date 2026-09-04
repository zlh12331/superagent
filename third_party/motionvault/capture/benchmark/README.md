# MotionLens Benchmark Harness

对 MotionVault 灵感库（同仓库 Vite 站点，11 个分类页、200 个已知动效）自动跑 MotionLens
提取引擎，产出覆盖率报告。**MotionVault 是本工具的天然标准答案测试集**——站内每个效果的
实现方式已知，覆盖率数字既用于质量保障，也是 README 的卖点素材。

## 怎么跑

```bash
# 前置：站点依赖已安装（npm install）；playwright 无需入库，按需安装
npm install --no-save playwright

node capture/benchmark/run.mjs                 # 默认：每分类 6 张卡（共 72）
node capture/benchmark/run.mjs --all           # 全量 200 张
node capture/benchmark/run.mjs --per 3 --category buttons,svg
node capture/benchmark/run.mjs --settle 2200 --sample-ms 3000 --port 4850
```

产物写入 `capture/benchmark/results/`：`report.json`（全量结构化数据）+ `report.md`
（人读报告，顶部是可贴 README 的摘要）。

## 流程

1. 检查站点 `dist/`（缺失则 `npm run build`，约 30s）。
2. 启动 `vite preview --port 4850 --strictPort`（子进程，结束按 PID SIGTERM→SIGKILL）。
3. esbuild 将 `inject.ts` 打成 IIFE，经 `page.addScriptTag` 注入，暴露 `window.__mlBench`
   （`cardCount / scan / hoverScan / sample`）。inject 直接编排 core 底层函数
   （`extractAnimations` / `sampleElement` / `fitSegments`），**不走 picker 交互点选**。
4. playwright（chromium，优先自带 headless shell，回退 `/usr/bin/chromium`）逐分类页执行。
   每卡管线（任一阶段命中即停）：
   1. **scan**：`scrollIntoView`（instant，触发 useInView 懒挂载）→ 等预览挂载 + 2.2s 就位 →
      结构化提取（`document.getAnimations({subtree:true})` 按预览容器过滤）；
   2. **replayScan**：settle 后挂载型动画已播完 → 点卡片「重新播放」按钮 remount 预览，
      在 200ms/600ms 两个窗口收集 running 动画；
   3. **hoverScan**：真实 hover（CDP 鼠标，触发 `:hover` 与 JS 监听）后 300ms/450ms 两次收集；
   4. **clickScan**：真实 click（目标 = preview 内第一个可交互子元素，退化为中心点）
      后 300ms/500ms 两次收集；
   5. **sample**：先 600ms 移动探针定位真正在动的后代（弥补 `sampleElement` deep 模式
      只采前 6 后代的截断），然后 `sampleElement(target, 3000ms, {deep:true})` +
      `fitSegments`；采样期间并发执行 pointer 横扫（`elementFromPoint` 落点派发
      pointermove/mousemove）+ 内部滚动容器（`.mv-scroll`）全程往返滚动 + window 滚动兜底，
      并在 400ms 处补一次真实 click；探针目标拟合为空时回退 preview 级采样。
5. 终止保护：单卡 60s、单页 180s 超时；页面 crash 记 error 并重建 page 继续。

## DOM 契约（选择器依据）

- 卡片：`article.group`（`src/components/EffectCard.tsx` 根节点）。
- **预览容器**：卡片内第一个 `div[class*="aspect-["]`，即
  `relative aspect-[16/10] w-full min-w-0 overflow-hidden rounded-xl …` 的预览窗口。
  预览组件经 `useInView`（rootMargin 160px）懒挂载，离屏即卸载，因此必须滚动到视口内。
- 卡片标题：`article h3`（用于结果 id）。

## 指标定义

- **覆盖率**：单卡「≥1 条结构化动画 或 sampled segments 非空」即记为覆盖。
- **分来源**：结构化动画按 `css / transition / waapi` 计数；采样兜底命中计 `sampled`（段数）。
- **拟合质量**：`avgSegmentError` = 各卡 segments 平均 error 的卡级均值（0-1，越小越准）。
- **trigger 分布**：结构化动画上的 trigger 标注（`load` = 滚动就位后直接可见；
  `hover` = 仅在 hover 阶段出现）。
- **失败清单**：`no-animation`（结构化+采样均为空）/ `timeout` / `error`，附原因。

## 已知边界（引擎能力画像，非 harness bug）

- GSAP / rAF 内联样式驱动（如边框光束的 `rotate(...)` inline style）对 `getAnimations`
  隐身，只能靠采样兜底 → 归 `sampled`。
- Canvas / WebGL / 粒子类在 computed style 上无标量通道，采样也采不到 → 预期
  `no-animation`（需要 vision 兜底，core 尚未实现）。
- 无限匀速旋转的采样拟合：rotate 通道 360°→0° 回绕导致残差偏高。
