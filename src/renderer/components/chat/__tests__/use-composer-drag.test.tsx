// src/renderer/components/chat/__tests__/use-composer-drag.test.tsx
// useComposerDrag：拖拽生命周期与清理
//
// 测试要点（聚焦 2026-09-11 修复的卸载泄漏路径）：
// 1. pointerdown 后在 document 上注册 pointermove/pointerup/pointercancel
// 2. pointerup 结束拖拽 → 三个监听全部移除（正常路径）
// 3. **拖拽进行中卸载组件 → 三个监听仍被移除**（本测试的核心：
//    此前仅依赖 pointerup，卸载时无兜底，监听与 dragRef 会滞留）
// 4. 拖拽移动按钳位规则改写 textarea 高度

import { cleanup, render } from '@testing-library/react';
import { type ReactElement, useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMPOSER_MAX_H, useComposerDrag } from '../use-composer-drag';

/** 测试宿主：一个 textarea + 一个绑定了 handleProps 的手柄 */
function Host(): ReactElement {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const { handleProps } = useComposerDrag(ref);
  return (
    <div>
      <hr data-testid="handle" {...handleProps} />
      <textarea ref={ref} data-testid="ta" />
    </div>
  );
}

/** 触发一次 pointerdown 开始拖拽（构造最小 PointerEvent） */
function startDrag(handle: HTMLElement): void {
  const down = new Event('pointerdown', { bubbles: true, cancelable: true }) as PointerEvent;
  // jsdom 未实现 PointerEvent 构造器，补足 hook 读取的字段
  Object.defineProperties(down, {
    clientY: { value: 300 },
    pointerId: { value: 1 },
  });
  // setPointerCapture 在 jsdom 中不存在，按需打桩
  const target = handle as HTMLElement & { setPointerCapture?: (id: number) => void };
  target.setPointerCapture = (): void => undefined;
  handle.dispatchEvent(down);
}

describe('useComposerDrag', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('pointerdown 后在 document 注册三个 pointer 监听', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const { getByTestId } = render(<Host />);

    startDrag(getByTestId('handle'));

    const added = addSpy.mock.calls.map((c) => c[0]);
    expect(added).toContain('pointermove');
    expect(added).toContain('pointerup');
    expect(added).toContain('pointercancel');
  });

  it('pointerup 结束拖拽 → 三个监听全部移除（正常路径）', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { getByTestId } = render(<Host />);

    startDrag(getByTestId('handle'));
    document.dispatchEvent(new Event('pointerup'));

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('pointermove');
    expect(removed).toContain('pointerup');
    expect(removed).toContain('pointercancel');
  });

  it('拖拽进行中卸载组件 → 三个监听仍被移除（卸载兜底，2026-09-11 修复）', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { getByTestId, unmount } = render(<Host />);

    startDrag(getByTestId('handle'));
    // 关键：不派发 pointerup，直接卸载（模拟切会话/关面板）
    unmount();

    const removed = removeSpy.mock.calls.map((c) => c[0]);
    expect(removed).toContain('pointermove');
    expect(removed).toContain('pointerup');
    expect(removed).toContain('pointercancel');
  });

  it('拖拽移动按钳位上限改写高度（不超过 COMPOSER_MAX_H）', () => {
    const { getByTestId } = render(<Host />);
    const ta = getByTestId('ta') as HTMLTextAreaElement;

    startDrag(getByTestId('handle'));
    // 向上拖 10000px → dy 极大 → 应钳位到 COMPOSER_MAX_H
    const move = new Event('pointermove', { bubbles: true }) as PointerEvent;
    Object.defineProperty(move, 'clientY', { value: -10000 });
    document.dispatchEvent(move);

    expect(ta.style.height).toBe(`${COMPOSER_MAX_H}px`);
    expect(ta.style.maxHeight).toBe(`${COMPOSER_MAX_H}px`);
  });
});
