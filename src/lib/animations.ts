import type { Transition, Variants } from 'motion/react'

/**
 * 应用共享的动画预设。
 *
 * 风格：流畅优雅 (smooth & elegant) — 基于弹簧动画，时长 250-300ms。
 * 这些预设用于确保所有动画组件的运动效果保持一致。
 */

/** 默认弹簧过渡 — 平滑、无明显回弹，约 250ms。 */
export const springTransition: Transition = {
  type: 'spring',
  stiffness: 300,
  damping: 30,
  mass: 0.8,
}

/** 用于较大元素（对话框、面板）的更柔和弹簧动画 — 约 300ms。 */
export const gentleSpring: Transition = {
  type: 'spring',
  stiffness: 200,
  damping: 26,
  mass: 1,
}

/** 淡入淡出 — 用于内容区切换。 */
export const fadeVariants: Variants = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
}

/** 从右滑入 + 淡入 — 用于偏好设置面板切换。 */
export const slideRightVariants: Variants = {
  initial: { opacity: 0, x: -12 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: 12 },
}

/** 从左滑入 + 淡入 — 用于右侧栏内容。 */
export const slideLeftVariants: Variants = {
  initial: { opacity: 0, x: 12 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -12 },
}

/** 缩放 + 淡入 — 用于快捷面板入场。 */
export const scaleFadeVariants: Variants = {
  initial: { opacity: 0, scale: 0.96 },
  animate: { opacity: 1, scale: 1 },
}
