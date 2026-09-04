// src/renderer/lib/motion/variants.ts
// 通用动画变体 · 业务组件复用
// ──────────────────────────────────────────────────────────────
// 设计原则：
// - 变体命名遵循 motion 惯例：hidden / visible / exit
// - 与 AnimatePresence 配合：AnimatePresence 会自动调用 exit 变体
// - 每个变体内置默认 transition，业务方可覆盖
//
// 使用方式：
//   import { AnimatePresence, motion } from 'motion/react';
//   import { fadeInVariants } from '@/lib/motion/variants';
//
//   <AnimatePresence>
//     {visible && (
//       <motion.div
//         variants={fadeInVariants}
//         initial="hidden"
//         animate="visible"
//         exit="exit"
//       />
//     )}
//   </AnimatePresence>
//
// 与 shadcn/ui 的边界：
// - shadcn 组件继续使用 tw-animate-css 的 data-state 类（不重写）
// - 业务自定义组件用 motion 变体（drawer / 通知 / 列表 stagger 等）
// ──────────────────────────────────────────────────────────────

import type { Variants } from 'motion/react';

import { easeIn, easeOut, easePaper, microTransition, smoothEaseOut } from './transitions';

/* ──────────────────────────────────────────────────────────────
   单元素变体
   ────────────────────────────────────────────────────────────── */

/**
 * 淡入淡出变体（最常用）
 *
 * 适合：消息出现、tooltip、loading 占位、状态切换
 */
export const fadeInVariants: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: smoothEaseOut,
  },
  exit: {
    opacity: 0,
    transition: microTransition,
  },
};

/**
 * 从下方滑入变体
 *
 * 适合：消息气泡、下拉菜单内容、列表新增项
 */
export const slideUpVariants: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.25,
      ease: easeOut,
    },
  },
  exit: {
    opacity: 0,
    y: 4,
    transition: {
      duration: 0.2,
      ease: easeIn,
    },
  },
};

/**
 * 从右侧滑入变体
 *
 * 适合：抽屉、侧边面板、Toast 通知
 */
export const slideRightVariants: Variants = {
  hidden: { opacity: 0, x: 16 },
  visible: {
    opacity: 1,
    x: 0,
    transition: {
      duration: 0.25,
      ease: easePaper,
    },
  },
  exit: {
    opacity: 0,
    x: 8,
    transition: {
      duration: 0.2,
      ease: easeIn,
    },
  },
};

/**
 * 缩放变体（从 95% 到 100%）
 *
 * 适合：对话框、弹出卡片、模态层
 */
export const scaleVariants: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: smoothEaseOut,
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    transition: microTransition,
  },
};

/**
 * 缩放 + 轻微上浮变体
 *
 * 适合：右键菜单、命令面板、强调弹出
 */
export const popVariants: Variants = {
  hidden: { opacity: 0, scale: 0.9, y: 4 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: {
      duration: 0.2,
      ease: easeOut,
    },
  },
  exit: {
    opacity: 0,
    scale: 0.9,
    y: 4,
    transition: microTransition,
  },
};

/**
 * 模糊上浮变体（MotionVault blur-fade 思路）
 *
 * 适合：欢迎页品牌区、首屏标题、强调内容入场。
 * filter: blur 动画由 motion 在独立合成层驱动，结束时归零不残留。
 */
export const blurUpVariants: Variants = {
  hidden: { opacity: 0, y: 16, filter: 'blur(8px)' },
  visible: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      duration: 0.5,
      ease: easePaper,
    },
  },
  exit: {
    opacity: 0,
    filter: 'blur(8px)',
    transition: microTransition,
  },
};

/* ──────────────────────────────────────────────────────────────
   列表 stagger 变体（配合 children 使用）
   ────────────────────────────────────────────────────────────── */

/**
 * stagger 容器变体
 *
 * 配合子元素的 fadeInVariants / slideUpVariants 使用：
 *   <motion.ul variants={staggerContainer} initial="hidden" animate="visible">
 *     {items.map(item => (
 *       <motion.li key={item.id} variants={slideUpVariants}>
 *         {item.label}
 *       </motion.li>
 *     ))}
 *   </motion.ul>
 *
 * 参数（业务方可覆盖）：
 * - staggerChildren: 0.05s（每项延迟 50ms）
 * - delayChildren: 0.1s（首项延迟 100ms）
 */
export const staggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.1,
    },
  },
};

/**
 * 快速 stagger 容器（适用于短列表、菜单）
 *
 * staggerChildren 0.03s + delayChildren 0.05s
 */
export const staggerContainerFast: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.03,
      delayChildren: 0.05,
    },
  },
};

/**
 * 慢速 stagger 容器（适用于长列表、章节列表）
 *
 * staggerChildren 0.08s + delayChildren 0.15s
 */
export const staggerContainerSlow: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.08,
      delayChildren: 0.15,
    },
  },
};

/* ──────────────────────────────────────────────────────────────
   字母级变体（欢迎页品牌 / 标题逐字入场）
   用法：容器元素 variants={letterContainerVariants} initial="hidden" animate="visible"，
   子元素每个字符一个 <motion.span variants={letterUpVariants}>。
   子元素 inline-block 包裹，父级需保留空格（渲染时对空格字符插入 \u00A0）。
   ────────────────────────────────────────────────────────────── */

/**
 * 字母 stagger 容器（逐字延迟 35ms 起笔）
 */
export const letterContainerVariants: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.035,
      delayChildren: 0.05,
    },
  },
};

/**
 * 单字母上浮 + 模糊入场变体（MotionVault letter-stagger 思路）
 *
 * 隐藏态：下移 0.4em + 4px 模糊；可见态：归位清晰。
 */
export const letterUpVariants: Variants = {
  hidden: { opacity: 0, y: '0.4em', filter: 'blur(4px)' },
  visible: {
    opacity: 1,
    y: 0,
    filter: 'blur(0px)',
    transition: {
      duration: 0.45,
      ease: easePaper,
    },
  },
};
