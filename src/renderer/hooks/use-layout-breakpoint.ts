// src/renderer/hooks/use-layout-breakpoint.ts
// 响应式断点 hook · 对齐原型 prototype-v2.html 断点策略
// ──────────────────────────────────────────────────────────────
// 职责：
// - 监听 2 档媒体查询：(max-width: 1200px) / (max-width: 900px)
// - 返回 { isCompact, isNarrow } 供 AppShell 驱动面板自动显隐
//
// 设计参考：
// - 原型 docs/prototype/prototype-v2.html 第 5836/5861 行的 @media 断点
// - 参考项目 src/components/layout/MainWindow.tsx 的 useLayoutBreakpoint
//
// 说明：
// - 600px / 480px 档的组件级响应式调整由 Tailwind 任意值断点前缀
//   （max-[600px]: / max-[480px]:）直接写在各组件 className 上，
//   此处仅保留 1200px / 900px 两档用于驱动面板显隐。
// ──────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';

/**
 * 响应式断点状态。
 */
export interface LayoutBreakpoint {
  /** <1200px：右面板应自动隐藏（可浮层抽屉唤出） */
  isCompact: boolean;
  /** <900px：侧栏应自动隐藏（可浮层抽屉唤出） */
  isNarrow: boolean;
}

/** SSR 安全的默认断点（Electron 无 SSR 但保持健壮性） */
const DEFAULT_BREAKPOINT: LayoutBreakpoint = {
  isCompact: false,
  isNarrow: false,
};

/**
 * 监听 2 档响应式断点并返回当前断点状态。
 *
 * 实现要点：
 * - 使用 window.matchMedia 监听（性能优于 resize 事件，浏览器节流）
 * - 惰性初始化（useState lazy initializer）同步读取当前断点，避免首屏闪烁
 * - 组件卸载时自动清理 matchMedia 监听器
 * - SSR 安全防御（typeof window 检查）
 */
export function useLayoutBreakpoint(): LayoutBreakpoint {
  const [breakpoint, setBreakpoint] = useState<LayoutBreakpoint>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return DEFAULT_BREAKPOINT;
    }
    return {
      isCompact: window.matchMedia('(max-width: 1200px)').matches,
      isNarrow: window.matchMedia('(max-width: 900px)').matches,
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    // 2 档断点的 MediaQueryList 与对应状态键
    const mqls = [
      {
        mq: window.matchMedia('(max-width: 1200px)'),
        key: 'isCompact' as const,
      },
      {
        mq: window.matchMedia('(max-width: 900px)'),
        key: 'isNarrow' as const,
      },
    ];

    // 监听每档断点变化，仅更新对应键（避免全量 re-render）
    const handlers = mqls.map(({ mq, key }) => {
      const handler = (e: MediaQueryListEvent) => {
        setBreakpoint((prev) => ({ ...prev, [key]: e.matches }));
      };
      mq.addEventListener('change', handler);
      return { mq, handler };
    });

    // 卸载时清理所有监听器，防止内存泄漏
    return () => {
      handlers.forEach(({ mq, handler }) => {
        mq.removeEventListener('change', handler);
      });
    };
  }, []);

  return breakpoint;
}
