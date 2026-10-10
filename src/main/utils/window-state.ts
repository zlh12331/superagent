import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BrowserWindow, Rectangle } from 'electron';

export interface WindowState {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly isMaximized: boolean;
}

const SAVE_DEBOUNCE_MS = 500;

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
