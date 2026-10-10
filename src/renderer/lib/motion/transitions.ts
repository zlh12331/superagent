import type { Transition } from 'motion/react';

/**
 * 标准缓出（最常用）
 *
 * 对应 styles/ 各域 css 的 --ease-soft: cubic-bezier(0.4, 0, 0.2, 1)
 * 适合：消息出现、列表项淡入、按钮反馈
 */
export const easeOut: [number, number, number, number] = [0.4, 0, 0.2, 1];

/**
 * 纸张缓动（更柔和）
 *
 * 对应 styles/ 各域 css 的 --ease-paper: cubic-bezier(0.25, 0.46, 0.45, 0.94)
 * 适合：面板展开、抽屉滑入、内容切换
 */
export const easePaper: [number, number, number, number] = [0.25, 0.46, 0.45, 0.94];

/**
 * 缓入（用于 exit 动画）
 *
 * 配合 easeOut 形成自然的进入-退出节奏
 */
export const easeIn: [number, number, number, number] = [0.4, 0, 1, 1];

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
