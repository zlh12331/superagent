// window.handler.ts：window 域 IPC——界面缩放（zoomFactor + win32 标题栏 overlay 高度联动）
import { clampZoom, overlayHeightFor } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

import { logger } from '../utils/logger';

/** 依赖注入工厂（无外部依赖） */
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
      // overlay 高度联动失败只告警：35 号实测 setTitleBarOverlay 在个别窗口状态下会抛，不影响缩放本体
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
