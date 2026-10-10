import { clampZoom, overlayHeightFor } from '@code-agent/shared/main';
import { BrowserWindow } from 'electron';

import { logger } from '../utils/logger';

/**
 * Window 域 handler 工厂（无外部依赖；zoom 值经 clampZoom 兜底归一——
 * 渲染层已 clamp，此处防御 handler 直调方）
 */
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

/**
 * Windows titleBarOverlay.height 随缩放联动（win32 专属）
 *
 * 52 DIP 是控件区基准（window.ts 创建参数）；CSS 顶栏随 zoomFactor 缩放而
 * overlay.height 固定，不联动则非 100% 档位窗口控件区与自绘顶栏错位。
 */
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
