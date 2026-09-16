// src/renderer/components/chat/use-composer-drag.ts
// 输入框高度拖拽（自 ChatInput 提取的 DOM 交互 hook）
// ──────────────────────────────────────────────
// 对齐原型 composerDragHandle：向上拖变高（钳位 [dragMinH, 460]）、
// 双击重置、键盘 ArrowUp/Down 20px 步进。
// 拖拽下限 = 内容自然高度与 160 的较小者（拖小不能小于内容所需高度，避免裁剪）。
// ──────────────────────────────────────────────

import { type KeyboardEvent, type PointerEvent, type RefObject, useEffect, useRef } from 'react';

/** 输入框拖拽高度上限（对齐原型 maxExtra 300 + 基础 160） */
export const COMPOSER_MAX_H = 460;
/** 拖拽下限基准（与 autoResize 默认 240px 封顶对齐的基准上限） */
const DRAG_BASE_MAX = 160;
/** 自动增长默认封顶（px，超过则滚动） */
export const COMPOSER_AUTO_MAX = 240;
/** 键盘步进（px） */
const KEYBOARD_STEP = 20;

/** 拖拽状态（起点 y + 起始高度 + 下限） */
interface DragState {
  readonly startY: number;
  readonly startH: number;
  readonly dragMinH: number;
}

/** 全局拖拽监听所需的上下文（收敛为单参数，同时满足「形参 ≤4」门槛） */
interface GlobalDragContext {
  readonly el: HTMLTextAreaElement;
  readonly state: DragState;
  readonly dragRef: RefObject<DragState | null>;
}

/**
 * 注册拖拽期的全局 pointer 监听，返回「结束拖拽」函数。
 *
 * 模块级提取的两个目的：
 * 1. 让 useComposerDrag 体量不因新增卸载兜底而增长（check-functions 棘轮只允许下降）；
 * 2. 「注册 → 返回清理」成对，使**正常结束**（pointerup / pointercancel）与
 *    **异常结束**（组件在拖拽中被卸载，见 hook 内的 useEffect）共用同一清理入口，
 *    不会出现某条路径漏移除。
 */
function startGlobalDrag(ctx: GlobalDragContext): () => void {
  const { el, state, dragRef } = ctx;
  const handleMove = (ev: globalThis.PointerEvent): void => {
    // 方向对齐原型：向上拖（clientY 减小）→ dy 增大 → 高度增大（手柄在输入框上方，向上拉高）
    const dy = state.startY - ev.clientY;
    const clamped = Math.max(state.dragMinH, Math.min(COMPOSER_MAX_H, state.startH + dy));
    if (clamped <= state.dragMinH) {
      // 触底档刻意让两值不等：height 贴合内容自然高度（不裁剪），maxHeight 回到基准档，
      // 使后续自动增高仍走 COMPOSER_AUTO_MAX 档（见 ChatInput.autoResize 的 manualCap 判定）。
      // 若此处把 maxHeight 也设为 dragMinH，拖到底后会永久压低自动增高上限
      el.style.maxHeight = `${DRAG_BASE_MAX}px`;
      el.style.height = `${state.dragMinH}px`;
    } else {
      el.style.maxHeight = `${clamped}px`;
      el.style.height = `${clamped}px`;
    }
  };
  const stop = (): void => {
    dragRef.current = null;
    document.removeEventListener('pointermove', handleMove);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
  };
  document.addEventListener('pointermove', handleMove);
  document.addEventListener('pointerup', stop);
  // pointercancel（触摸板手势接管/窗口拖动等系统取消）不走 pointerup——
  // 缺失会导致 dragRef 滞留，之后任意移动持续改写高度
  document.addEventListener('pointercancel', stop);
  return stop;
}

/** 手柄元素 props（展开到 <hr className="composer-drag-handle"> 上） */
export interface ComposerDragHandleProps {
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLHRElement>) => void;
}

export interface ComposerDrag {
  /** 展开到拖拽手柄上的事件 props */
  readonly handleProps: ComposerDragHandleProps;
}

/**
 * 输入框高度拖拽 hook
 *
 * @param textareaRef 目标 textarea（高度直接写 style，与 autoResize 共存）
 */
export function useComposerDrag(textareaRef: RefObject<HTMLTextAreaElement | null>): ComposerDrag {
  const dragRef = useRef<DragState | null>(null);
  /** 当前拖拽的「结束」函数（正常结束时自清；组件卸载时由下方 useEffect 兜底调用） */
  const endDragRef = useRef<(() => void) | null>(null);

  // 卸载兜底（2026-09-11 补）：拖拽进行中组件被卸载（切会话/关闭面板）时 pointerup
  // 不会再派发，document 上的 pointermove/pointerup/pointercancel 监听与 dragRef 会滞留
  // ——监听闭包同时持有 dragRef 与已分离的 textarea 引用，构成句柄泄漏。
  // 回归守卫见 __tests__/use-composer-drag.test.tsx 的「拖拽进行中卸载组件」用例。
  useEffect(
    () => () => {
      endDragRef.current?.();
      endDragRef.current = null;
    },
    [],
  );

  /** 测量 textarea 自然高度（临时解除高度/上限限制，对齐原型 measureNaturalH） */
  const measureNaturalHeight = (el: HTMLTextAreaElement): number => {
    const prevHeight = el.style.height;
    const prevMax = el.style.maxHeight;
    el.style.height = 'auto';
    el.style.maxHeight = 'none';
    const height = el.scrollHeight;
    el.style.height = prevHeight;
    el.style.maxHeight = prevMax;
    return height;
  };

  /** 拖拽开始：记录起点 + 指针捕获，注册全局 pointer 监听（对齐原型 onDown/onMove/onUp） */
  const handleDragStart = (event: PointerEvent<HTMLDivElement>): void => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    event.preventDefault();
    // 指针捕获：拖拽过程中 pointer 移出手柄元素不丢失事件
    event.currentTarget.setPointerCapture(event.pointerId);
    const state: DragState = {
      startY: event.clientY,
      startH: el.offsetHeight,
      dragMinH: Math.min(measureNaturalHeight(el), DRAG_BASE_MAX),
    };
    dragRef.current = state;
    endDragRef.current = startGlobalDrag({ el, state, dragRef });
  };

  /** 双击手柄重置：恢复自动高度（对齐原型 resetResize：maxHeight 清空 + 自动增长） */
  const handleReset = (): void => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    el.style.maxHeight = '';
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, COMPOSER_AUTO_MAX)}px`;
  };

  /** 键盘步进：ArrowUp 增高 / ArrowDown 降高（手柄 hr 可聚焦，键盘可达） */
  const handleKeyDown = (event: KeyboardEvent<HTMLHRElement>): void => {
    const el = textareaRef.current;
    if (el === null || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? KEYBOARD_STEP : -KEYBOARD_STEP;
    const current = el.offsetHeight;
    // 下限与拖拽路径对齐：不低于内容自然高度（避免键盘把输入框缩到裁剪内容），
    // 拖拽路径见 handleDragStart 的 dragMinH = min(naturalH, DRAG_BASE_MAX)
    const minH = Math.min(measureNaturalHeight(el), DRAG_BASE_MAX);
    const next = Math.max(minH, Math.min(COMPOSER_MAX_H, current + delta));
    el.style.maxHeight = `${next}px`;
    el.style.height = `${next}px`;
  };

  return {
    handleProps: {
      onPointerDown: handleDragStart,
      onDoubleClick: handleReset,
      onKeyDown: handleKeyDown,
    },
  };
}
