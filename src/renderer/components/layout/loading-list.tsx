// src/renderer/components/layout/loading-list.tsx
// 侧边栏 · 加载占位（5 行骨架屏）
// ──────────────────────────────────────────────
// 拆分背景：Sidebar 641 行，按职责提取
// 动效（2026-09-04）：骨架行错落淡入（MotionVault loader 类思路），
// 每行 60ms 间隔，缓解"空白闪烁"；尊重 reducedMotion（MotionConfig 全局降级）
// ──────────────────────────────────────────────

import { motion } from 'motion/react';
import type { ReactElement } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { easePaper } from '@/lib/motion';

/** 加载中骨架屏（5 行占位） */
export function LoadingList(): ReactElement {
  return (
    <ul className="flex flex-col gap-1 p-1">
      {Array.from({ length: 5 }).map((_, index) => (
        <motion.li
          // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
          key={index}
          className="px-2 py-2"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, delay: index * 0.06, ease: easePaper }}
        >
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="mt-2 h-2 w-1/2" />
        </motion.li>
      ))}
    </ul>
  );
}
