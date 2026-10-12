// window-state.ts：窗口位置/尺寸持久化——500ms 防抖采样、tmp+rename 原子写、
// 恢复时可见性校验（显示器拔掉后窗口会残留在屏幕外）
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

/** 窗口状态持久化结构（x/y 缺省 = 交还 Electron 默认定位） */
export interface WindowState {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
}

// resize/move 高频触发，500ms 合并写一次足够（状态文件只有几十字节）
const SAVE_DEBOUNCE_MS = 500;

/**
 * 窗口中心点落在任一显示器工作区内才算可见
 *
 * 用中心点而非四角：部分露出屏幕边缘的窗口仍算用户放置，只有整体被拔掉的显示器甩出去才重置
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
 * 加载窗口状态：字段逐一容错（类型不对用默认）；坐标不可见时丢弃 x/y 保留尺寸；
 * 文件损坏/缺失整体回落默认尺寸
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
 * 挂窗口状态跟踪：resize/move 防抖写，maximize/unmaximize 离散切换立即写，close 最终落盘
 *
 * 写入用 tmp+rename 原子替换——写一半崩溃不会留下半截 JSON
 *
 * @returns 解绑函数（移除全部监听 + 取消挂起防抖）
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
