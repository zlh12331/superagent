// src/renderer/components/chat/use-composer-drag.ts
// 输入框高度拖拽（自 ChatInput 提取的 DOM 交互 hook）
// ──────────────────────────────────────────────
// 对齐原型 composerDragHandle：向上拖变高（钳位 [dragMinH, 460]）、
// 双击重置、键盘 ArrowUp/Down 20px 步进。
// 拖拽下限 = 内容自然高度与 160 的较小者（拖小不能小于内容所需高度，避免裁剪）。
// ──────────────────────────────────────────────

import { type KeyboardEvent, type PointerEvent, type RefObject, useRef } from 'react';

/** 输入框拖拽高度下限（单行，约 40px） */
export const COMPOSER_MIN_H = 40;
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
    const naturalHeight = measureNaturalHeight(el);
    dragRef.current = {
      startY: event.clientY,
      startH: el.offsetHeight,
      dragMinH: Math.min(naturalHeight, DRAG_BASE_MAX),
    };
    const handleMove = (ev: globalThis.PointerEvent): void => {
      const state = dragRef.current;
      if (state === null) {
        return;
      }
      // 方向对齐原型：向上拖（clientY 减小）→ dy 增大 → 高度增大（手柄在输入框上方，向上拉高）
      const dy = state.startY - ev.clientY;
      const clamped = Math.max(state.dragMinH, Math.min(COMPOSER_MAX_H, state.startH + dy));
      if (clamped <= state.dragMinH) {
        el.style.maxHeight = `${DRAG_BASE_MAX}px`;
        el.style.height = `${state.dragMinH}px`;
      } else {
        el.style.maxHeight = `${clamped}px`;
        el.style.height = `${clamped}px`;
      }
    };
    const handleUp = (): void => {
      dragRef.current = null;
      document.removeEventListener('pointermove', handleMove);
      document.removeEventListener('pointerup', handleUp);
      document.removeEventListener('pointercancel', handleUp);
    };
    document.addEventListener('pointermove', handleMove);
    document.addEventListener('pointerup', handleUp);
    // pointercancel（触摸板手势接管/窗口拖动等系统取消）不走 pointerup——
    // 缺失会导致 dragRef 滞留，之后任意移动持续改写高度
    document.addEventListener('pointercancel', handleUp);
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
    const next = Math.max(COMPOSER_MIN_H, Math.min(COMPOSER_MAX_H, current + delta));
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
