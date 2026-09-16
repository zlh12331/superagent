// src/renderer/components/browser/browser-device-bar.tsx
// 浏览器预览设备工具栏（从 browser-pane 提取：预设/宽高/缩放控件）
// ──────────────────────────────────────────────────────────────
// 纯受控组件：全部状态与回调由 browser-pane 持有（工具栏内临时改动不写回
// 设置，真源管理见 use-browser-viewport 与 settings-store）。
// 预设/缩放档位取自 lib/browser/presets（与设置页同一真源）。
// ──────────────────────────────────────────────────────────────

import { X } from 'lucide-react';
import type { ReactElement } from 'react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/i18n/use-translation';
import { DEVICE_PRESETS, ZOOM_STEPS } from '@/lib/browser/presets';
import { cn } from '@/lib/utils';
import type { BrowserDevicePreset, BrowserZoom } from '@/stores/persistent/settings-store';
import { TOOLBAR_BTN_CLASS } from './browser-toolbar';

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

/**
 * 预设文案键（key 字面量必须留在本文件：check-i18n 的「间接引用」规则
 * 要求 key 与 t(变量) 同文件，见 lib/browser/presets 头部说明）
 */
const PRESET_LABEL_KEYS: Record<BrowserDevicePreset, string> = {
  responsive: 'panel.browserDeviceResponsive',
  desktop: 'panel.browserDeviceDesktop',
  laptop: 'panel.browserDeviceLaptop',
  tablet: 'panel.browserDeviceTablet',
  mobile: 'panel.browserDeviceMobile',
};

/**
 * 解析宽高输入：空串 / 非有限数 / 非正值一律返回 null（调用方保持上一个有效值）
 *
 * 必要性：`Number('')` 为 0（不是 NaN），此前仅判 NaN 会让「清空输入框」
 * 把宽高置 0 → 视口矩形宽度 0 违反 BrowserRectSchema.positive() → IPC 校验
 * 失败被静默吞掉，视口同步无声失效。
 */
function parseDimension(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

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
        {DEVICE_PRESETS.map((preset) => {
          // 局部常量再传给 t：check-i18n 的间接引用识别只覆盖 t(标识符) 形态
          const labelKey = PRESET_LABEL_KEYS[preset];
          return (
            <option key={preset} value={preset}>
              {t(labelKey)}
            </option>
          );
        })}
      </select>
      <div className="flex shrink-0 items-center gap-0.5">
        <input
          type="number"
          value={deviceWidth}
          onChange={(e) => {
            const value = parseDimension(e.target.value);
            if (value !== null) onWidthChange(value);
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
            const value = parseDimension(e.target.value);
            if (value !== null) onHeightChange(value);
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
        {ZOOM_STEPS.map((zoom) => (
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
