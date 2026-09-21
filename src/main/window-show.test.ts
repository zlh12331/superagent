// src/main/window-show.test.ts
// 主窗口唤回唯一实现的单测
// ──────────────────────────────────────────────────────────────
// 覆盖两条 2026-09-21 实测缺陷的修复语义：
// - P0-1：静默启动时 maximize() 会显示窗口 ⇒ 改为 pending 标志，首次唤回时应用
// - P0-2：隐藏窗口上 focus() 不显示 ⇒ 唤回必须经 showMainWindow（内含 show()）
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  /** 伪窗口：记录调用顺序，isVisible 在 show()/maximize() 后变 true（对齐 Electron 语义） */
  const makeWin = (opts: { minimized?: boolean; destroyed?: boolean } = {}) => {
    const calls: string[] = [];
    const win = {
      calls,
      visible: false,
      minimized: opts.minimized ?? false,
      destroyed: opts.destroyed ?? false,
      isDestroyed(): boolean {
        return win.destroyed;
      },
      isVisible(): boolean {
        return win.visible;
      },
      isMinimized(): boolean {
        return win.minimized;
      },
      restore(): void {
        calls.push('restore');
        win.minimized = false;
      },
      maximize(): void {
        calls.push('maximize');
        // Electron 语义：maximize 会显示未显示的窗口（electron.d.ts:3101）
        win.visible = true;
      },
      show(): void {
        calls.push('show');
        win.visible = true;
      },
      focus(): void {
        calls.push('focus');
      },
    };
    return win;
  };
  return { makeWin, windows: [] as ReturnType<typeof makeWin>[] };
});

vi.mock('electron', () => ({
  // 字符串键：避免 useNamingConvention 对 PascalCase 属性名的检查（与 devtools.handler.test 同法）
  ['BrowserWindow']: {
    getAllWindows: () => mocks.windows,
  },
}));

vi.mock('./utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { bringMainWindowToFront, markMaximizeOnNextShow, showMainWindow } from './window-show';

describe('window-show（主窗口唤回唯一实现）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.windows.length = 0;
  });

  describe('showMainWindow', () => {
    it('无窗口 → 返回 false 且不抛错', () => {
      expect(showMainWindow()).toBe(false);
    });

    it('窗口已销毁 → 返回 false（不对已销毁对象操作）', () => {
      mocks.windows.push(mocks.makeWin({ destroyed: true }));
      expect(showMainWindow()).toBe(false);
    });

    it('隐藏窗口（非最小化）→ show + focus，窗口变为可见（P0-2 的核心断言）', () => {
      const win = mocks.makeWin();
      mocks.windows.push(win);

      expect(showMainWindow()).toBe(true);

      // 关键：show() 必须被调用——此前 second-instance 只做 focus()，隐藏窗口唤不出
      expect(win.calls).toEqual(['show', 'focus']);
      expect(win.isVisible()).toBe(true);
      expect(win.calls).not.toContain('restore'); // 未最小化时无需 restore
    });

    it('最小化窗口 → restore 在 show 之前', () => {
      const win = mocks.makeWin({ minimized: true });
      mocks.windows.push(win);

      showMainWindow();

      expect(win.calls).toEqual(['restore', 'show', 'focus']);
    });

    it('未调用 markMaximizeOnNextShow 时不 maximize（普通唤回不改变窗口尺寸）', () => {
      const win = mocks.makeWin();
      mocks.windows.push(win);

      showMainWindow();

      expect(win.calls).not.toContain('maximize');
    });
  });

  describe('markMaximizeOnNextShow（P0-1 的配套：静默启动时延迟最大化）', () => {
    it('标记后首次唤回执行 maximize（随后仍 show，作跨平台兜底）', () => {
      const win = mocks.makeWin();
      mocks.windows.push(win);
      markMaximizeOnNextShow();

      showMainWindow();

      // maximize 与 show 都在：maximize 负责"回到最大化态"，show 负责"确保可见"。
      // 实测（.tmp 探针，2026-09-21）：Electron 上 maximize 之后紧接 show() 不改变
      // isMaximized 与 bounds（前后一致 1722×1034），故多这一次 show 无副作用；
      // 反之若某平台 maximize() 不显示窗口，show() 是必要的兜底。
      expect(win.calls).toEqual(['maximize', 'show', 'focus']);
      expect(win.isVisible()).toBe(true);
    });

    it('pending 标志只生效一次：第二次唤回不再 maximize', () => {
      const win = mocks.makeWin();
      mocks.windows.push(win);
      markMaximizeOnNextShow();

      showMainWindow();
      win.calls.length = 0; // 清掉首次记录
      showMainWindow();

      expect(win.calls).toEqual(['show', 'focus']);
    });

    it('无窗口时标记不被消费（下次有窗口时仍生效）', () => {
      markMaximizeOnNextShow();
      expect(showMainWindow()).toBe(false);

      const win = mocks.makeWin();
      mocks.windows.push(win);
      showMainWindow();

      expect(win.calls).toContain('maximize');
    });
  });

  describe('bringMainWindowToFront（Dock / 二次启动 / 托盘共用）', () => {
    it('有窗口 → 唤回，不调用 create', () => {
      const win = mocks.makeWin();
      mocks.windows.push(win);
      const create = vi.fn();

      bringMainWindowToFront(create);

      expect(create).not.toHaveBeenCalled();
      expect(win.isVisible()).toBe(true);
    });

    it('无窗口（macOS 关窗后窗口被销毁）→ 调用 create 重建', () => {
      const create = vi.fn(() => {
        mocks.windows.push(mocks.makeWin());
      });

      bringMainWindowToFront(create);

      expect(create).toHaveBeenCalledTimes(1);
    });
  });
});
