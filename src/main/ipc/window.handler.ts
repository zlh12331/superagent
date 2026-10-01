// src/main/ipc/window.handler.ts
// Window 域 IPC handler（window:applyZoom 界面缩放应用，35 号 spec §2.1/§2.3）
// ──────────────────────────────────────────────────────────────
// 单点收口：渲染层 sandbox 无 webContents 句柄，setZoomFactor 与 Windows
// titleBarOverlay.height 联动在此一处原子完成——遍历全部 BrowserWindow
// （未来多窗口语义已正确；WebContentsView 非 BrowserWindow，浏览器预览
// 分区天然不在遍历集，应用缩放与预览缩放构造性隔离）。
//
// 失败路径：单窗口操作失败（销毁竞态）静默跳过其余窗口；setTitleBarOverlay
// try/catch + warn 不阻断缩放（window-theme.ts 先例是刻意静默，本 handler
// 独立文件无该约束）。
// ──────────────────────────────────────────────────────────────

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
          // 单窗口失败不阻断其余窗口（销毁竞态等）
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
    // 部分 Windows 版本/窗口态下 API 可能抛错（非致命，控件区退化为创建时配置）
    logger.warn({ error: String(err), zoom }, 'titleBarOverlay 高度联动失败（缩放不受影响）');
  }
}
