import { useEffect, useState } from 'react';

import { BREAKPOINT_COMPACT, BREAKPOINT_NARROW } from '@/lib/constants';

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
      isCompact: window.matchMedia(`(max-width: ${BREAKPOINT_COMPACT}px)`).matches,
      isNarrow: window.matchMedia(`(max-width: ${BREAKPOINT_NARROW}px)`).matches,
    };
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mqls = [
      {
        mq: window.matchMedia(`(max-width: ${BREAKPOINT_COMPACT}px)`),
        key: 'isCompact' as const,
      },
      {
        mq: window.matchMedia(`(max-width: ${BREAKPOINT_NARROW}px)`),
        key: 'isNarrow' as const,
      },
    ];

    const handlers = mqls.map(({ mq, key }) => {
      const handler = (e: MediaQueryListEvent) => {
        setBreakpoint((prev) => ({ ...prev, [key]: e.matches }));
      };
      mq.addEventListener('change', handler);
      return { mq, handler };
    });

    return () => {
      handlers.forEach(({ mq, handler }) => {
        mq.removeEventListener('change', handler);
      });
    };
  }, []);

  return breakpoint;
}
