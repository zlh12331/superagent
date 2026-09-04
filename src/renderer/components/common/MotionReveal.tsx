// src/renderer/components/common/MotionReveal.tsx
// 通用入场动效包装 · 一行启用
// ──────────────────────────────────────────────────────────────
// 职责：为子内容提供统一的入场动画（挂载即播 / 进入视口即播）。
// 灵感来源于 MotionVault（third_party/motionvault）的 Reveal 类组件，
// 但复用本项目 lib/motion 的缓动体系与 tokens，不引入外部依赖。
//
// 用法：
//   <MotionReveal variant="blurUp" delay={0.15}>
//     <h1>标题</h1>
//   </MotionReveal>
//   <MotionReveal variant="fadeIn" inView>
//     <Card />   {/* 滚动进入视口时淡入（播放一次） */}
//   </MotionReveal>
//
// 无障碍：动画纯视觉层不改语义；配合全局 MotionConfig reducedMotion 尊重系统减弱动效。
// ──────────────────────────────────────────────────────────────

import { motion, type Transition, type Variants } from 'motion/react';
import type { ReactElement, ReactNode } from 'react';

import { easePaper, fadeInVariants, slideUpVariants } from '@/lib/motion';
import { cn } from '@/lib/utils';

/** 预设变体（模糊上浮 / 滑入 / 淡入） */
const PRESET_VARIANTS = {
  blurUp: {
    hidden: { opacity: 0, y: 16, filter: 'blur(8px)' },
    visible: { opacity: 1, y: 0, filter: 'blur(0px)' },
  },
  slideUp: slideUpVariants,
  fadeIn: fadeInVariants,
} satisfies Record<string, Variants>;

type MotionRevealProps = {
  readonly children: ReactNode;
  readonly className?: string;
  /** 入场延迟（秒） */
  readonly delay?: number;
  /** 变体预设：blurUp（默认，模糊上浮）/ slideUp / fadeIn */
  readonly variant?: keyof typeof PRESET_VARIANTS;
  /** 是否为滚动触发：true 时元素进入视口才播放（仅一次，底部偏移 -40px） */
  readonly inView?: boolean;
};

/**
 * 通用入场动效包装
 */
export function MotionReveal({
  children,
  className,
  delay = 0,
  variant = 'blurUp',
  inView = false,
}: MotionRevealProps): ReactElement {
  const base = PRESET_VARIANTS[variant];
  // 追加统一 transition（时长/缓动/延迟），业务方无需每处重复
  const transition: Transition = { duration: 0.5, ease: easePaper, delay };
  const variantsWithDelay: Variants = {
    hidden: base.hidden,
    visible: { ...base.visible, transition },
  };

  if (inView) {
    return (
      <motion.div
        className={cn(className)}
        variants={variantsWithDelay}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, margin: '0px 0px -40px 0px' }}
      >
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div
      className={cn(className)}
      variants={variantsWithDelay}
      initial="hidden"
      animate="visible"
    >
      {children}
    </motion.div>
  );
}
