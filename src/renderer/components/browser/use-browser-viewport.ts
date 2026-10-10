import { type RefObject, useEffect } from 'react';
import { hasIpcBridge } from '@/lib/ipc';
import type { BrowserDevicePreset } from '@/stores/persistent/settings-store';
import { useConfirmDialogStore } from '@/stores/transient/confirm-dialog-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { computeViewportLayout, type HostRect } from './browser-geometry';

/** useBrowserViewport 参数 */
export interface UseBrowserViewportParams {
  /** 占位区元素 ref */
  readonly hostRef: RefObject<HTMLDivElement | null>;
  readonly preset: BrowserDevicePreset;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  /** 缩放百分比（50–200） */
  readonly zoom: number;
  /** 是否已加载页面（未加载时不创建/显示视图，让位给空状态提示） */
  readonly active: boolean;
  /** 严格沙箱（禁用预览页 JS） */
  readonly strictSandbox: boolean;
}

/** 测量占位区（display:none 时 getBoundingClientRect 返回 0×0 → null） */
function measureHost(hostRef: RefObject<HTMLDivElement | null>): HostRect | null {
  const el = hostRef.current;
  if (el === null) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * 视口同步 hook（无返回值：副作用全部收敛到主进程视图）
 */
export function useBrowserViewport(params: UseBrowserViewportParams): void {
  const { hostRef, preset, deviceWidth, deviceHeight, zoom, active, strictSandbox } = params;
  const overlayOpen = useUiStore(
    (state) => state.settingsOpen || state.paletteOpen || state.shortcutHelpOpen,
  );
  const confirmOpen = useConfirmDialogStore((state) => state.currentRequest !== null);
  const occluded = overlayOpen || confirmOpen;

  useEffect(() => {
    if (!hasIpcBridge()) return;
    const push = (): void => {
      const layout = computeViewportLayout({
        hostRect: measureHost(hostRef),
        preset,
        deviceWidth,
        deviceHeight,
        zoom,
      });
      const visible = layout.rect !== null && !occluded && active;
      void window.api.browser
        .setViewport({ rect: layout.rect, visible, zoomFactor: layout.zoomFactor })
        .catch(() => {});
    };
    push();
    const host = hostRef.current;
    const observer =
      host !== null && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(push) : null;
    if (observer !== null && host !== null) {
      observer.observe(host);
    }
    window.addEventListener('resize', push);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', push);
    };
  }, [hostRef, preset, deviceWidth, deviceHeight, zoom, occluded, active]);

  useEffect(() => {
    if (!hasIpcBridge()) return;
    const api = window.api.browser;
    return () => {
      void api.setViewport({ rect: null, visible: false, zoomFactor: 1 }).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!hasIpcBridge()) return;
    void window.api.browser.configure({ strictSandbox }).catch(() => {});
  }, [strictSandbox]);
}
