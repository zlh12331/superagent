import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

/** 持久化窗口状态形状 */
export interface WindowState {
  /** 窗口 X 坐标（未记忆时为 undefined，走系统默认位置） */
  readonly x?: number;
  /** 窗口 Y 坐标（未记忆时为 undefined，走系统默认位置） */
  readonly y?: number;
  /** 窗口宽度（px） */
  readonly width: number;
  /** 窗口高度（px） */
  readonly height: number;
  /** 是否最大化 */
  readonly isMaximized: boolean;
}

/** move/resize 防抖保存间隔（毫秒） */
const SAVE_DEBOUNCE_MS = 500;

/**
 * 判定窗口 bounds 是否与任一显示器工作区相交（可恢复性校验）
 *
 * 屏幕拔插 / 分辨率变更后，上次记忆的 bounds 可能完全落在屏幕外
 * （如外接屏右侧 -1000px），直接恢复会导致窗口不可见。
 * 相交判定：bounds 中心点落在某个 workArea 内即视为可见。
 *
 * @param bounds 窗口 bounds
 * @param workAreas 所有显示器的 workArea 列表
 * @returns true = 可安全恢复；false = 应回退系统默认位置
 */
export function isBoundsVisible(bounds: Rectangle, workAreas: readonly Rectangle[]): boolean {
  const centerX = bounds.x + bounds.width / 2;
  const centerY = bounds.y + bounds.height / 2;
  return workAreas.some(
    (area) =>
      centerX >= area.x &&
      centerX < area.x + area.width &&
      centerY >= area.y &&
      centerY < area.y + area.height,
  );
}

/**
 * 读取持久化窗口状态（带校验）
 *
 * @param filePath 状态文件路径（通常为 userData/window-state.json）
 * @param defaults 文件缺失/损坏/不可见时的回退默认值
 * @param workAreas 当前所有显示器工作区（校验用；由调用方在 app ready 后传入）
 * @returns 可恢复的窗口状态（校验失败时返回 defaults）
 */
export function loadWindowState(
  filePath: string,
  defaults: { readonly width: number; readonly height: number },
  workAreas: readonly Rectangle[],
): WindowState {
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<WindowState>;
    const width = typeof parsed.width === 'number' ? parsed.width : defaults.width;
    const height = typeof parsed.height === 'number' ? parsed.height : defaults.height;
    const x = typeof parsed.x === 'number' ? parsed.x : undefined;
    const y = typeof parsed.y === 'number' ? parsed.y : undefined;
    const isMaximized = parsed.isMaximized === true;
    if (
      x === undefined ||
      y === undefined ||
      !isBoundsVisible({ x, y, width, height }, workAreas)
    ) {
      return { width, height, isMaximized };
    }
    return { x, y, width, height, isMaximized };
  } catch {
    return { width: defaults.width, height: defaults.height, isMaximized: false };
  }
}

/**
 * 跟踪窗口状态变化并持久化（move/resize 防抖 + 最大化即时 + close 同步兜底）
 *
 * @param win 目标窗口（创建后立即调用）
 * @param filePath 状态文件路径
 * @returns 清理函数（窗口 destroyed 时调用，移除监听）
 */
export function trackWindowState(win: BrowserWindow, filePath: string): () => void {
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const persist = (): void => {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    const state: WindowState = {
      ...(bounds.x !== undefined ? { x: bounds.x } : {}),
      ...(bounds.y !== undefined ? { y: bounds.y } : {}),
      width: bounds.width,
      height: bounds.height,
      isMaximized: win.isMaximized(),
    };
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmpPath = `${filePath}.tmp`;
      writeFileSync(tmpPath, JSON.stringify(state), 'utf8');
      renameSync(tmpPath, filePath);
    } catch {}
  };

  const schedulePersist = (): void => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      persist();
    }, SAVE_DEBOUNCE_MS);
  };

  const onMaximizedChange = (): void => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    persist();
  };

  win.on('resize', schedulePersist);
  win.on('move', schedulePersist);
  win.on('maximize', onMaximizedChange);
  win.on('unmaximize', onMaximizedChange);
  win.on('close', persist);

  return () => {
    if (saveTimer !== undefined) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    win.removeListener('resize', schedulePersist);
    win.removeListener('move', schedulePersist);
    win.removeListener('maximize', onMaximizedChange);
    win.removeListener('unmaximize', onMaximizedChange);
    win.removeListener('close', persist);
  };
}
