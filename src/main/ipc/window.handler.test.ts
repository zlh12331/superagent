// src/main/ipc/window.handler.test.ts
// window:applyZoom handler 单测（35 号 §2.7：V2/V7/V8 断言）
// ──────────────────────────────────────────────────────────────
// mock electron BrowserWindow（多窗口遍历/销毁守卫/setZoomFactor）+
// process.platform（win32 overlay 联动分支）。
// ──────────────────────────────────────────────────────────────

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  /** 伪窗口集合：每项含 setZoomFactor/setTitleBarOverlay 的 spy */
  const windows: {
    destroyed: boolean;
    setZoomFactor: ReturnType<typeof vi.fn>;
    setTitleBarOverlay: ReturnType<typeof vi.fn>;
  }[] = [];
  return { windows };
});

/** process.platform stub（handler 读真实 process.platform，不可用内部变量） */
function setPlatform(p: string): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

vi.mock('electron', () => ({
  // 字符串键：规避 useNamingConvention 对 PascalCase 属性名的检查（window-show.test 同法）
  ['BrowserWindow']: {
    getAllWindows: () =>
      mocks.windows.map((w) => ({
        isDestroyed: () => w.destroyed,
        webContents: { setZoomFactor: w.setZoomFactor },
        setTitleBarOverlay: w.setTitleBarOverlay,
      })),
  },
}));

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { createWindowHandlers } from './window.handler';

function addWindow(destroyed = false): {
  setZoomFactor: ReturnType<typeof vi.fn>;
  setTitleBarOverlay: ReturnType<typeof vi.fn>;
} {
  const win = {
    destroyed,
    setZoomFactor: vi.fn(),
    setTitleBarOverlay: vi.fn(),
  };
  mocks.windows.push(win);
  return win;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.windows.length = 0;
  setPlatform('win32');
});

describe('window:applyZoom handler（35 号界面缩放）', () => {
  it('V2：遍历全部窗口执行 setZoomFactor（值经 clampZoom 归一）', async () => {
    const a = addWindow();
    const b = addWindow();

    const res = await createWindowHandlers().applyZoom({ zoom: 1.25 });

    expect(res).toEqual({ ok: true });
    expect(a.setZoomFactor).toHaveBeenCalledWith(1.25);
    expect(b.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('损坏值（0.93）→ clampZoom 归一后应用', async () => {
    const a = addWindow();

    await createWindowHandlers().applyZoom({ zoom: 0.93 });

    expect(a.setZoomFactor).toHaveBeenCalledWith(0.9);
  });

  it('V8 构造性隔离：仅遍历 BrowserWindow（WebContentsView 不在 mock 集，构造上不可达）', async () => {
    // 本测试的隔离证明是构造性的：handler 只调 BrowserWindow.getAllWindows()，
    // WebContentsView（浏览器预览分区）不是 BrowserWindow，无法出现在遍历集。
    addWindow();
    addWindow();
    const res = await createWindowHandlers().applyZoom({ zoom: 1.5 });
    expect(res).toEqual({ ok: true });
    // 每个窗口都被应用一次
    for (const w of mocks.windows) {
      expect(w.setZoomFactor).toHaveBeenCalledTimes(1);
    }
  });

  it('销毁窗口跳过，其余继续（失败路径）', async () => {
    const dead = addWindow(true);
    const alive = addWindow();

    const res = await createWindowHandlers().applyZoom({ zoom: 1.25 });

    expect(res).toEqual({ ok: true });
    expect(dead.setZoomFactor).not.toHaveBeenCalled();
    expect(alive.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('V7 win32：overlay.height 联动（1.25 → 65）', async () => {
    const a = addWindow();

    await createWindowHandlers().applyZoom({ zoom: 1.25 });

    expect(a.setTitleBarOverlay).toHaveBeenCalledWith({ height: 65 });
  });

  it('V7 非 win32：不调 setTitleBarOverlay（macOS/Linux 无 overlay 语义）', async () => {
    setPlatform('darwin');
    const a = addWindow();

    await createWindowHandlers().applyZoom({ zoom: 1.25 });

    expect(a.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(a.setZoomFactor).toHaveBeenCalledWith(1.25);
  });

  it('V7 100% 回落 52', async () => {
    const a = addWindow();

    await createWindowHandlers().applyZoom({ zoom: 1 });

    expect(a.setTitleBarOverlay).toHaveBeenCalledWith({ height: 52 });
  });

  it('overlay API 抛错 → warn 不阻断缩放（反例 7）', async () => {
    const a = addWindow();
    a.setTitleBarOverlay.mockImplementation(() => {
      throw new Error('unsupported window state');
    });

    const res = await createWindowHandlers().applyZoom({ zoom: 1.25 });

    expect(res).toEqual({ ok: true });
    expect(a.setZoomFactor).toHaveBeenCalledWith(1.25);
  });
});
