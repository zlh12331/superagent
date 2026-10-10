import { clampZoom, overlayHeightFor } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

import { logger } from '../utils/logger';

export function createWindowHandlers(): {
  applyZoom: (input: { zoom: number }) => Promise<{ ok: boolean }>;
} {
  return {
    applyZoom: async (input) => {
      const zoom = clampZoom(input.zoom);
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          if (!win.isDestroyed()) {
            win.webContents.setZoomFactor(zoom);
          }
        } catch (err) {
          logger.warn({ error: String(err) }, '窗口缩放应用失败（跳过该窗口）');
        }
      }
      applyTitleBarOverlayHeight(zoom);
      return { ok: true };
    },
  };
}

function applyTitleBarOverlayHeight(zoom: number): void {
  if (process.platform !== 'win32') {
    return;
  }
  const win = BrowserWindow.getAllWindows()[0];
  if (win === undefined || win.isDestroyed()) {
    return;
  }
  try {
    win.setTitleBarOverlay({ height: overlayHeightFor(zoom) });
  } catch (err) {
    logger.warn({ error: String(err), zoom }, 'titleBarOverlay 高度联动失败（缩放不受影响）');
  }
}
