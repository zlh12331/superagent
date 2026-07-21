// src/renderer/lib/motion/transitions.ts
// 动画过渡预设 · 统一项目内动效节奏
// ──────────────────────────────────────────────────────────────
// 设计哲学：
// - 借鉴 Material Design 的 duration easing 规范
// - 与 globals.css 的 --ease-soft / --ease-paper 变量对齐
// - 4 档时长：micro(短促反馈) / fast(组件过渡) / normal(面板展开) / slow(全屏切换)
//
// 使用方式：
//   import { smoothEaseOut, springTransition } from '@/lib/motion/transitions';
//   <motion.div animate={...} transition={smoothEaseOut} />
//
// 与 tw-animate-css 的边界：
// - tw-animate-css：负责 Radix 组件基于 data-state 的 CSS enter/exit
// - 本文件：负责业务 JS 动画的过渡曲线预设
// ──────────────────────────────────────────────────────────────

import type { Transition } from 'motion/react';

/* ──────────────────────────────────────────────────────────────
   缓动曲线（与 globals.css 的 --ease-soft / --ease-paper 对齐）
   ──────────────────────────────────────────────────────────────
   注意：类型用 [number, number, number, number] 而非 Transition['ease']，
   因为 exactOptionalPropertyTypes 模式下 Transition['ease'] 会带上 undefined，
   导致赋值给内联 transition.ease 时报错。
   cubic-bezier tuple 是 motion Easing 类型的合法子集，可安全赋值。 */

/**
 * 标准缓出（最常用）
 *
 * 对应 globals.css 的 --ease-soft: cubic-bezier(0.4, 0, 0.2, 1)
 * 适合：消息出现、列表项淡入、按钮反馈
 */
export const easeOut: [number, number, number, number] = [0.4, 0, 0.2, 1];

/**
 * 纸张缓动（更柔和）
 *
 * 对应 globals.css 的 --ease-paper: cubic-bezier(0.25, 0.46, 0.45, 0.94)
 * 适合：面板展开、抽屉滑入、内容切换
 */
export const easePaper: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];

/**
 * 缓入（用于 exit 动画）
 *
 * 配合 easeOut 形成自然的进入-退出节奏
 */
export const easeIn: [number, number, number, number] = [0.4, 0, 1, 1];

/* ──────────────────────────────────────────────────────────────
   过渡预设
   ────────────────────────────────────────────────────────────── */

/**
 * 微交互过渡（按钮点击、图标反馈）
 *
 * 时长 150ms + easeOut，给人「即时响应」感
 */
export const microTransition: Transition = {
  duration: 0.15,
  ease: easeOut,
};

/**
 * 平滑淡入过渡（消息出现、列表项淡入）
 *
 * 时长 200ms + easeOut，适合大多数 UI 元素的出现
 */
export const smoothEaseOut: Transition = {
  duration: 0.2,
  ease: easeOut,
};

/**
 * 面板过渡（抽屉滑入、面板展开）
 *
 * 时长 250ms + easePaper，更柔和的曲线适合较大面积的内容切换
 */
export const panelTransition: Transition = {
  duration: 0.25,
  ease: easePaper,
};

/**
 * 全屏过渡（视图切换、路由切换）
 *
 * 时长 300ms + easePaper，给用户足够时间感知状态变化
 */
export const slowTransition: Transition = {
  duration: 0.3,
  ease: easePaper,
};

/* ──────────────────────────────────────────────────────────────
   弹簧预设（物理感更强，适合可拖拽元素）
   ────────────────────────────────────────────────────────────── */

/**
 * 弹簧预设（柔和）
 *
 * 适合：抽屉拖拽回弹、可拖拽元素释放
 */
export const springTransition: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 30,
};

/**
 * 弹簧预设（活泼）
 *
 * 适合：通知 toast 弹出、徽章数字变化
 */
export const bouncySpringTransition: Transition = {
  type: 'spring',
  stiffness: 500,
  damping: 15,
};

/**
 * 弹簧预设（沉重）
 *
 * 适合：大面板拖拽、全屏对话框
 */
export const heavySpringTransition: Transition = {
  type: 'spring',
  stiffness: 200,
  damping: 40,
};
