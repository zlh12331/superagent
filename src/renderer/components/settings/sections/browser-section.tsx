// src/renderer/components/settings/sections/browser-section.tsx
// 浏览器 pane（右面板「浏览器」tab 的进程外预览设置）
// ──────────────────────────────────────────────────────────────
// 三项配置写穿透 SQLite app_settings 的 browser 分组（settings-store）：
// - defaultDevicePreset / defaultZoom：pane 挂载初值（工具栏内临时改动不写回）
// - strictSandbox：安全策略，切换即经 browser:configure 通知主进程
//   重建 WebContentsView（禁用预览页 JS），服务侧值一致时幂等 no-op
// 预设/缩放文案复用 panel.browserDevice* 既有键，避免同一概念两套译名；
// 档位数据取自 lib/browser/presets（与预览工具栏同一真源，此前两处各存一份）。
// ──────────────────────────────────────────────────────────────

import { Globe } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { DEVICE_PRESETS, ZOOM_STEPS } from '@/lib/browser/presets';
import type { BrowserDevicePreset } from '@/stores/persistent/settings-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SegControl, SettingRow, ToggleRow } from '../settings-controls';

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

/** 浏览器 pane */
export function BrowserSection(): ReactElement {
  const { t } = useTranslation();
  const browser = useSettingsStore((s) => s.browser);
  const updateBrowser = useSettingsStore((s) => s.updateBrowser);

  const handlePresetChange = (value: string): void => {
    const next = DEVICE_PRESETS.find((preset) => preset === value);
    if (next !== undefined) {
      updateBrowser({ defaultDevicePreset: next });
    }
  };

  const handleZoomChange = (value: string): void => {
    const next = ZOOM_STEPS.find((zoom) => String(zoom) === value);
    if (next !== undefined) {
      updateBrowser({ defaultZoom: next });
    }
  };

  /** 严格模式切换：写穿透设置 + 通知主进程重建预览视图（即时生效） */
  const handleStrictChange = (checked: boolean): void => {
    updateBrowser({ strictSandbox: checked });
    void window.api.browser.configure({ strictSandbox: checked }).catch(() => {});
  };

  return (
    <div className="flex flex-col gap-3 pt-2">
      <div className="flex items-center gap-2">
        <Globe className="text-muted-foreground size-3.5" strokeWidth={1.5} />
        <h3 className="text-foreground text-sm font-semibold">{t('settings.nav.browser')}</h3>
      </div>
      <p className="text-muted-foreground max-w-md text-xs leading-relaxed">
        {t('settings.browser.hint')}
      </p>

      <SettingRow
        label={t('settings.browser.defaultPreset')}
        description={t('settings.browser.defaultPresetHint')}
      >
        <SegControl
          value={browser.defaultDevicePreset}
          onChange={handlePresetChange}
          options={DEVICE_PRESETS.map((preset) => {
            // 局部常量再传给 t：check-i18n 的间接引用识别只覆盖 t(标识符) 形态
            const labelKey = PRESET_LABEL_KEYS[preset];
            return { value: preset, label: t(labelKey) };
          })}
        />
      </SettingRow>

      <SettingRow
        label={t('settings.browser.defaultZoom')}
        description={t('settings.browser.defaultZoomHint')}
      >
        <SegControl
          value={String(browser.defaultZoom)}
          onChange={handleZoomChange}
          options={ZOOM_STEPS.map((zoom) => ({ value: String(zoom), label: `${zoom}%` }))}
        />
      </SettingRow>

      <ToggleRow
        name={t('settings.browser.strictSandbox')}
        description={t('settings.browser.strictSandboxHint')}
        checked={browser.strictSandbox}
        onChange={handleStrictChange}
      />
    </div>
  );
}
