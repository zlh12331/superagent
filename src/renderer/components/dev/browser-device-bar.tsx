// src/renderer/components/dev/browser-device-bar.tsx
// 浏览器预览设备工具栏（从 browser-pane 提取：预设/宽高/缩放控件）
// ──────────────────────────────────────────────────────────────
// 纯受控组件：全部状态与回调由 browser-pane 持有（工具栏内临时改动不写回
// 设置，真源管理见 use-browser-viewport 与 settings-store）。
// ──────────────────────────────────────────────────────────────

import { X } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import type { BrowserDevicePreset, BrowserZoom } from '@/stores/persistent/settings-store';

/** 与 browser-pane 工具栏一致的图标按钮基础样式 */
const TOOLBAR_BTN_CLASS =
  'flex size-6 shrink-0 cursor-pointer items-center justify-center rounded border-none bg-transparent p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-30';

/** DeviceBar props（受控） */
export interface DeviceBarProps {
  readonly devicePreset: BrowserDevicePreset;
  readonly deviceWidth: number;
  readonly deviceHeight: number;
  readonly deviceZoom: BrowserZoom;
  readonly onPresetChange: (preset: BrowserDevicePreset) => void;
  readonly onWidthChange: (width: number) => void;
  readonly onHeightChange: (height: number) => void;
  readonly onZoomChange: (zoom: BrowserZoom) => void;
  readonly onClose: () => void;
}

/** 缩放档位（与设置页 ZOOM_STEPS 同源：50–200%） */
const ZOOM_OPTIONS: readonly BrowserZoom[] = [50, 75, 100, 125, 150, 200];

/**
 * 设备工具栏（预设下拉 + 宽高输入 + 缩放下拉 + 关闭）
 */
export function DeviceBar(props: DeviceBarProps): ReactElement {
  const { t } = useTranslation();
  const {
    devicePreset,
    deviceWidth,
    deviceHeight,
    deviceZoom,
    onPresetChange,
    onWidthChange,
    onHeightChange,
    onZoomChange,
    onClose,
  } = props;

  return (
    <div className="border-border bg-muted/30 flex h-7 shrink-0 items-center gap-1.5 border-b px-2">
      <select
        value={devicePreset}
        onChange={(e) => onPresetChange(e.target.value as BrowserDevicePreset)}
        aria-label={t('panel.browserDevicePreset')}
        className="border-border bg-background text-muted-foreground h-[22px] shrink-0 cursor-pointer rounded border px-1.5 text-xs focus:border-primary"
      >
        <option value="responsive">{t('panel.browserDeviceResponsive')}</option>
        <option value="desktop">{t('panel.browserDeviceDesktop')}</option>
        <option value="laptop">{t('panel.browserDeviceLaptop')}</option>
        <option value="tablet">{t('panel.browserDeviceTablet')}</option>
        <option value="mobile">{t('panel.browserDeviceMobile')}</option>
      </select>
      <div className="flex shrink-0 items-center gap-0.5">
        <input
          type="number"
          value={deviceWidth}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (!Number.isNaN(value)) onWidthChange(value);
          }}
          min={200}
          max={3000}
          disabled={devicePreset === 'responsive'}
          aria-label={t('panel.browserDeviceWidth')}
          className="border-border bg-background text-muted-foreground h-[22px] w-[42px] rounded border text-center font-mono text-xs disabled:opacity-40"
        />
        <span className="text-muted-foreground px-0.5 font-mono text-xs">×</span>
        <input
          type="number"
          value={deviceHeight}
          onChange={(e) => {
            const value = Number(e.target.value);
            if (!Number.isNaN(value)) onHeightChange(value);
          }}
          min={200}
          max={3000}
          disabled={devicePreset === 'responsive'}
          aria-label={t('panel.browserDeviceHeight')}
          className="border-border bg-background text-muted-foreground h-[22px] w-[42px] rounded border text-center font-mono text-xs disabled:opacity-40"
        />
      </div>
      <select
        value={deviceZoom}
        onChange={(e) => onZoomChange(Number(e.target.value) as BrowserZoom)}
        aria-label={t('panel.browserZoom')}
        className="border-border bg-background text-muted-foreground h-[22px] shrink-0 cursor-pointer rounded border px-1 text-xs"
      >
        {ZOOM_OPTIONS.map((zoom) => (
          <option key={zoom} value={zoom}>
            {zoom}%
          </option>
        ))}
      </select>
      <Button
        variant="ghost"
        size="icon"
        title={t('panel.browserCloseDeviceBar')}
        aria-label={t('panel.browserCloseDeviceBar')}
        onClick={onClose}
        className={cn(TOOLBAR_BTN_CLASS, 'ml-auto shrink-0')}
      >
        <X className="size-3" strokeWidth={1.5} />
      </Button>
    </div>
  );
}
