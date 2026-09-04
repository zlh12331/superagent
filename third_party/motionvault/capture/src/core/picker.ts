/**
 * picker.ts —— 全屏点选器。
 * 设计要点：
 * - 所有注入 DOM 均 pointer-events:none，交互通过 document 上的捕获阶段监听器完成，
 *   因此不拦截页面原有滚动（wheel/touch 完全不受影响）。
 * - 高亮框用 position:fixed 独立 div 绘制（outline + box-shadow），绝不修改目标元素本身。
 * - 左键选定（拦截 click 默认行为避免误触页面链接/按钮），ESC / 右键取消。
 */
import type { PickerOptions } from './types';

const Z_INDEX = '2147483646';
const DEFAULT_HINT = '点击选择动效元素 · ESC 取消';

export function pickElement(opts: PickerOptions = {}): Promise<Element | null> {
  return new Promise<Element | null>((resolve) => {
    const hint = opts.hint ?? DEFAULT_HINT;

    // ---- 注入 DOM（全部 pointer-events:none，纯视觉层）----
    const root = document.createElement('div');
    root.setAttribute('data-motionlens-picker', '');
    root.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:' + Z_INDEX + ';';

    const box = document.createElement('div');
    box.style.cssText =
      'position:fixed;display:none;pointer-events:none;z-index:' + Z_INDEX + ';' +
      'outline:2px solid #4f8cff;outline-offset:1px;' +
      'box-shadow:0 0 0 4px rgba(79,140,255,0.25),inset 0 0 0 9999px rgba(79,140,255,0.08);' +
      'border-radius:2px;';

    const bar = document.createElement('div');
    bar.textContent = hint;
    bar.style.cssText =
      'position:fixed;top:0;left:50%;transform:translateX(-50%);pointer-events:none;' +
      'z-index:' + Z_INDEX + ';padding:8px 16px;background:rgba(20,22,28,0.92);color:#fff;' +
      'font:13px/1.5 -apple-system,system-ui,sans-serif;border-radius:0 0 8px 8px;' +
      'box-shadow:0 2px 12px rgba(0,0,0,0.3);white-space:nowrap;';

    root.append(box, bar);

    // 十字光标样式（注入 <style>，结束后移除）
    const style = document.createElement('style');
    style.textContent = '[data-motionlens-picker-active] *, [data-motionlens-picker-active] { cursor: crosshair !important; }';
    document.documentElement.setAttribute('data-motionlens-picker-active', '');
    document.head.append(style);
    document.body.append(root);

    let lastTarget: Element | null = null;
    let done = false;

    const isOwnDom = (t: EventTarget | null): boolean =>
      t instanceof Node && root.contains(t);

    const updateBox = (el: Element | null): void => {
      if (!el || isOwnDom(el)) {
        box.style.display = 'none';
        lastTarget = null;
        return;
      }
      lastTarget = el;
      const r = el.getBoundingClientRect();
      box.style.display = 'block';
      box.style.left = r.left + 'px';
      box.style.top = r.top + 'px';
      box.style.width = r.width + 'px';
      box.style.height = r.height + 'px';
    };

    const cleanup = (): void => {
      document.removeEventListener('mousemove', onMouseMove, true);
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('mouseup', onMouseUp, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('contextmenu', onContextMenu, true);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', onScroll, true);
      root.remove();
      style.remove();
      document.documentElement.removeAttribute('data-motionlens-picker-active');
    };

    const finish = (result: Element | null): void => {
      if (done) return;
      done = true;
      cleanup();
      resolve(result);
    };

    function onMouseMove(e: MouseEvent): void {
      const t = e.target instanceof Element ? e.target : null;
      updateBox(t && !isOwnDom(t) ? t : null);
    }

    // 阻止按下/抬起的默认行为（避免聚焦、文本选中等副作用），不阻止滚动
    function onMouseDown(e: MouseEvent): void {
      e.preventDefault();
    }

    function onMouseUp(e: MouseEvent): void {
      e.preventDefault();
    }

    function onClick(e: MouseEvent): void {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (e.button !== 0) return;
      const t = e.target instanceof Element && !isOwnDom(e.target)
        ? e.target
        : lastTarget;
      finish(t);
    }

    function onContextMenu(e: MouseEvent): void {
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    }

    // 页面滚动时高亮框跟随（不 preventDefault，滚动不受影响）
    function onScroll(): void {
      if (lastTarget) updateBox(lastTarget);
    }

    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('contextmenu', onContextMenu, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScroll, true);
  });
}
