# MotionVault（vendored 参考源）

**来源**：<https://github.com/xiyu519/MotionVault> （MIT License，clone 于 2026-09-04，commit 0a201da）

## 这是什么

第三方**网页动效灵感库**：10 个分类、202 个动效组件（text/card/button/background/particle/scroll/svg/loader/spring/3D），每个效果带 AI 复现 prompt。本目录为**只读参考源**，不参与本项目构建（不在 tsconfig / biome / knip 扫描范围）。

## 用途

为 `src/renderer` 前端视觉与交互美化提供动效灵感。用法：

1. 浏览 `src/components/effects/<分类>/` 找合适效果；
2. 参考其实现思路（时长/缓动/结构），但**用本项目自己的抽象**落地：

   - 动画库：`motion/react`（与仓库的 Framer Motion 同源）

   - 动效基础设施：`src/renderer/lib/motion/`（variants + transitions，统一节奏）

   - 设计 token：`src/renderer/styles/tokens.css`（禁止硬编码颜色/圆角/阴影）
3. 大依赖（GSAP / three.js / R3F 等）**不得**引入——bundle 体积门槛（check-bundle）不允。

## 注意事项

- 仓库原技术栈为 Vite 7 + Tailwind 3（本项目 Vite 8 + Tailwind 4），组件不能直接复制粘贴，只借鉴动效参数。

- 不修改本目录内容（如需要精确版本可 `git -C . log` 对照）。

