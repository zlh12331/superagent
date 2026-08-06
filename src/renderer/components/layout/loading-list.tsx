// loading-list.tsx（自 Sidebar 拆分）
// 侧边栏 · 加载占位（5 行骨架屏）
// ──────────────────────────────
// 拆分背景：Sidebar 641 行，按职责提取
// ──────────────────────────────

import type { ReactElement } from 'react';
import { Skeleton } from '@/components/ui/skeleton';

/** 加载中骨架屏（5 行占位） */
export function LoadingList(): ReactElement {
  return (
    <ul className="flex flex-col gap-1 p-1">
      {Array.from({ length: 5 }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 静态骨架屏占位，index 稳定且无重排
        <li key={index} className="px-2 py-2">
          <Skeleton className="h-3 w-3/4" />
          <Skeleton className="mt-2 h-2 w-1/2" />
        </li>
      ))}
    </ul>
  );
}
