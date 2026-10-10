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
  const stop = (): void => {
    dragRef.current = null;
    document.removeEventListener('pointermove', handleMove);
    document.removeEventListener('pointerup', stop);
    document.removeEventListener('pointercancel', stop);
  };
  document.addEventListener('pointermove', handleMove);
  document.addEventListener('pointerup', stop);
  document.addEventListener('pointercancel', stop);
  return stop;
}

/** 手柄元素 props（展开到 <hr className="composer-drag-handle"> 上） */
export interface ComposerDragHandleProps {
  readonly onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onDoubleClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLHRElement>) => void;
}

/** 输入框高度拖拽 hook 返回：拖拽手柄事件 props（展开到 hr 手柄上） */
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
