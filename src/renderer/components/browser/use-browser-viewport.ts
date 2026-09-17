// src/renderer/components/browser/use-browser-viewport.ts
// 浏览器预览视口 hook：占位区测量 + 遮挡避让 + 严格模式同步
// ──────────────────────────────────────────────────────────────
// 职责：
// - ResizeObserver + window resize → 测量占位区 rect，经 browser:setViewport
//   推送边界/缩放/可见性（DevPanel 用 hidden 切换不卸载 DOM：隐藏时
//   getBoundingClientRect 为 0×0 → rect=null → 主进程侧隐藏视图，页面保活）
// - 全局遮挡源（设置/命令面板/快捷键帮助/确认弹窗）打开时隐藏原生视图——
//   WebContentsView 是窗口级图层，永远盖在渲染层之上，DOM z-index 管不住
// - 严格模式设置变化 → browser:configure（服务侧值不变时幂等 no-op）
// ──────────────────────────────────────────────────────────────

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
  // 全局遮挡源：任一打开 → 原生视图让位（否则模态框/确认弹窗被盖住）
  const overlayOpen = useUiStore(
    (state) => state.settingsOpen || state.paletteOpen || state.shortcutHelpOpen,
  );
  const confirmOpen = useConfirmDialogStore((state) => state.currentRequest !== null);
  const occluded = overlayOpen || confirmOpen;

  useEffect(() => {
    // 无桥（浏览器模式 / preload 缺失）时 window.api 成员访问即抛 TypeError，
    // 后续 .catch 兜不住（lib/ipc.ts hasIpcBridge 说明），故整段跳过。
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
      // 高频 invoke：失败静默（应用退出/窗口销毁的竞态无需打扰用户）
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

  // 卸载（关闭浏览器 tab）→ 隐藏视图，页面保活（切回 tab 时重新推送恢复显示）
  // 独立 effect 且空依赖：此前这段挂在同步 effect 的 cleanup 上，每次 deps
  // 变化（缩放/预设/尺寸/遮挡）都会先推一次 hide 再推新状态——原生视图层
  // 会收到多余的「先隐后显」对，与「仅卸载时隐藏」的语义不符。
  useEffect(() => {
    // cleanup 内同样不能裸访问 window.api：React 卸载流程中抛错会中断清理
    if (!hasIpcBridge()) return;
    const api = window.api.browser;
    return () => {
      void api.setViewport({ rect: null, visible: false, zoomFactor: 1 }).catch(() => {});
    };
  }, []);

  // 严格模式同步（服务侧与当前值一致时幂等 no-op，不重建视图）
  useEffect(() => {
    if (!hasIpcBridge()) return;
    void window.api.browser.configure({ strictSandbox }).catch(() => {});
  }, [strictSandbox]);
}
