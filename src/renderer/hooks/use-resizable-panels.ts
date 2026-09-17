// src/renderer/hooks/use-resizable-panels.ts
// 左右面板宽度拖拽/键盘调整（resizer 交互）
// ──────────────────────────────────────────────────────────────
// 职责：
// - 鼠标拖拽两条分隔线调整 sidebar / rightPanel 宽度（含 clamp 上下限）
// - 键盘调整：←/→ 16px 步进、Home/End 跳到极值
// - 拖拽期 body.resizing 类（全局光标/禁用选中）+ 卸载时清理监听
// - 把宽度同步到根元素 CSS 变量（供 .view-chat 的 grid-template-columns 用）
//
// 提取动机（2026-09 layout 审计）：这套逻辑原内联在 AppShell（约 100 行、
// 5 个 useState/useCallback/useRef + 3 个 effect），使 AppShell 成为认知复杂度
// 25 的基线条目。宽度约束本身是独立关注点（CSS 令牌 → JS 数值），与布局编排无关。
//
// 宽度上下限来自 layout-utils（从 CSS 令牌动态解析，JS 不硬编码像素）。
// ──────────────────────────────────────────────────────────────

import type { KeyboardEvent, MouseEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  computeInitialRightPanelWidth,
  computeInitialSidebarWidth,
  RIGHT_PANEL_WIDTH_MAX,
  RIGHT_PANEL_WIDTH_MIN,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
} from '@/components/layout/layout-utils';

/** 可拖拽的分隔线标识 */
export type ResizerSide = 'left' | 'right';

/** 键盘调整步进（px） */
const RESIZER_KEY_STEP = 16;

/** 把数值 clamp 到 [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** 键盘调整意图（按键 → 目标宽度的计算方式） */
type KeyIntent =
  | { readonly kind: 'step'; readonly delta: number }
  | { readonly kind: 'extreme'; readonly edge: 'min' | 'max' };

/**
 * 解析键盘调整意图
 *
 * 从按键与分隔线推导「怎么改宽度」，与具体 state setter 解耦——
 * 这层纯映射把原实现里「两层嵌套 if × 左右分支 × handled 可变标志」
 * （认知复杂度 25）压成线性判断。
 *
 * 方向语义：左侧分隔线右移 = 侧栏变宽；右侧分隔线右移 = 面板变窄（符号相反）。
 *
 * @returns 意图；null 表示该键与此分隔线无关（调用方不得拦截事件）
 */
function resolveKeyIntent(side: ResizerSide, key: string): KeyIntent | null {
  if (key === 'Home') return { kind: 'extreme', edge: 'min' };
  if (key === 'End') return { kind: 'extreme', edge: 'max' };
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null;
  const towardRight = key === 'ArrowRight';
  const growsOnRight = side === 'left';
  const sign = towardRight === growsOnRight ? 1 : -1;
  return { kind: 'step', delta: sign * RESIZER_KEY_STEP };
}

/** 该分隔线对应面板的宽度上下限（来自 layout-utils 的 CSS 令牌解析） */
function boundsOf(side: ResizerSide): { readonly min: number; readonly max: number } {
  return side === 'left'
    ? { min: SIDEBAR_WIDTH_MIN, max: SIDEBAR_WIDTH_MAX }
    : { min: RIGHT_PANEL_WIDTH_MIN, max: RIGHT_PANEL_WIDTH_MAX };
}

interface ResizablePanels {
  /** 侧边栏当前宽度（px） */
  readonly sidebarWidth: number;
  /** 右面板当前宽度（px） */
  readonly rightPanelWidth: number;
  /** 正在拖拽的分隔线（null = 未拖拽，用于添加 dragging 样式） */
  readonly draggingSide: ResizerSide | null;
  /** 分隔线 mousedown 处理器工厂 */
  readonly onResizerMouseDown: (side: ResizerSide) => (event: MouseEvent<HTMLHRElement>) => void;
  /** 分隔线 keydown 处理器工厂 */
  readonly onResizerKeyDown: (side: ResizerSide) => (event: KeyboardEvent<HTMLHRElement>) => void;
}

/**
 * 面板宽度与分隔线交互
 *
 * @param sidebarCollapsed 侧栏是否折叠（折叠时 CSS 变量置 0）
 * @param rightPanelCollapsed 右面板是否折叠（同上）
 *
 * @example
 * ```tsx
 * const { sidebarWidth, draggingSide, onResizerMouseDown } =
 *   useResizablePanels(sidebarCollapsed, rightPanelCollapsed);
 * <hr onMouseDown={onResizerMouseDown('left')} className={cn('resizer', draggingSide === 'left' && 'dragging')} />
 * ```
 */
export function useResizablePanels(
  sidebarCollapsed: boolean,
  rightPanelCollapsed: boolean,
): ResizablePanels {
  // 初始宽度对齐原型 clamp() 行为，按视口宽度计算
  const [sidebarWidth, setSidebarWidth] = useState(computeInitialSidebarWidth);
  const [rightPanelWidth, setRightPanelWidth] = useState(computeInitialRightPanelWidth);
  const [draggingSide, setDraggingSide] = useState<ResizerSide | null>(null);

  // 拖拽起始信息（ref：拖拽过程中变化频繁，不应触发重渲染）
  const dragStartRef = useRef<{ side: ResizerSide; startX: number; startWidth: number } | null>(
    null,
  );

  // 同步 CSS 变量到根元素（供 .view-chat 的 grid-template-columns 使用）
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty('--aurora-sidebar-w', sidebarCollapsed ? '0px' : `${sidebarWidth}px`);
    root.style.setProperty(
      '--aurora-right-panel-w',
      rightPanelCollapsed ? '0px' : `${rightPanelWidth}px`,
    );
  }, [sidebarWidth, rightPanelWidth, sidebarCollapsed, rightPanelCollapsed]);

  const handleMouseMove = useCallback((event: globalThis.MouseEvent) => {
    const dragStart = dragStartRef.current;
    if (dragStart === null) return;

    const delta = event.clientX - dragStart.startX;
    if (dragStart.side === 'left') {
      setSidebarWidth(clamp(dragStart.startWidth + delta, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX));
    } else {
      // 右侧分隔线左移 = 面板变宽，故符号相反
      setRightPanelWidth(
        clamp(dragStart.startWidth - delta, RIGHT_PANEL_WIDTH_MIN, RIGHT_PANEL_WIDTH_MAX),
      );
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    document.body.classList.remove('resizing');
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
    dragStartRef.current = null;
    setDraggingSide(null);
  }, [handleMouseMove]);

  const onResizerMouseDown = useCallback(
    (side: ResizerSide) => (event: MouseEvent<HTMLHRElement>) => {
      event.preventDefault();
      const startWidth = side === 'left' ? sidebarWidth : rightPanelWidth;
      dragStartRef.current = { side, startX: event.clientX, startWidth };
      setDraggingSide(side);
      document.body.classList.add('resizing');
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [sidebarWidth, rightPanelWidth, handleMouseMove, handleMouseUp],
  );

  // 卸载时清理监听（防御性：拖拽中组件被卸载时不留全局监听）
  useEffect(() => {
    return () => {
      document.body.classList.remove('resizing');
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // 键盘调整（此前仅 ARIA 语义 + tabIndex，无方向键行为）：
  // ←/→ 步进（右侧分隔线右移 = 面板变窄），Home/End 跳极值
  const onResizerKeyDown = useCallback(
    (side: ResizerSide) => (event: KeyboardEvent<HTMLHRElement>) => {
      const intent = resolveKeyIntent(side, event.key);
      // 无关按键不拦截（让事件继续冒泡，避免吞掉其它快捷键）
      if (intent === null) return;
      event.preventDefault();
      event.stopPropagation();

      const { min, max } = boundsOf(side);
      const setWidth = side === 'left' ? setSidebarWidth : setRightPanelWidth;
      setWidth((w) => {
        if (intent.kind === 'extreme') return intent.edge === 'min' ? min : max;
        return clamp(w + intent.delta, min, max);
      });
    },
    [],
  );

  return {
    sidebarWidth,
    rightPanelWidth,
    draggingSide,
    onResizerMouseDown,
    onResizerKeyDown,
  };
}
