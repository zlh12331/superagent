// src/renderer/lib/motion/index.ts
// motion 动画工具入口
// ──────────────────────────────────────────────────────────────
// 模块职责：
// - 提供通用动画变体（Variants）与过渡预设（Transition）
// - 业务组件统一从此处导入，避免散落各处的魔法数字
//
// 与 tw-animate-css 的边界（并存原则）：
// - tw-animate-css：CSS 工具类，负责 Radix 组件基于 data-state 的 enter/exit
//   （shadcn/ui 组件继续使用，不重写）
// - motion：React 组件库，负责业务 JS 动画
//   （消息气泡、抽屉、列表 stagger、拖拽反馈、视图切换等）
//
// 使用示例：
//   import { AnimatePresence, motion } from 'motion/react';
//   import { fadeInVariants, slideUpVariants, staggerContainer } from '@/lib/motion';
//
//   // 单元素
//   <motion.div variants={fadeInVariants} initial="hidden" animate="visible" exit="exit">
//     ...
//   </motion.div>
//
//   // stagger 列表
//   <motion.ul variants={staggerContainer} initial="hidden" animate="visible">
//     {items.map(item => (
//       <motion.li key={item.id} variants={slideUpVariants}>
//         {item.label}
//       </motion.li>
//     ))}
//   </motion.ul>
// ──────────────────────────────────────────────────────────────

// 类型再导出（业务方可能需要 Variants / Transition 类型）
export type { Transition, Variants } from 'motion/react';
// 过渡预设
export {
  bouncySpringTransition,
  easeIn,
  // 缓动曲线
  easeOut,
  easePaper,
  heavySpringTransition,
  // 过渡预设
  microTransition,
  panelTransition,
  slowTransition,
  smoothEaseOut,
  // 弹簧预设
  springTransition,
} from './transitions';
// 动画变体
export {
  // 单元素
  blurUpVariants,
  fadeInVariants,
  // 字母级
  letterContainerVariants,
  letterUpVariants,
  popVariants,
  scaleVariants,
  slideRightVariants,
  slideUpVariants,
  // stagger 容器
  staggerContainer,
  staggerContainerFast,
  staggerContainerSlow,
} from './variants';
