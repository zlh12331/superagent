// src/renderer/components/settings/sections/browser-section.tsx
// 浏览器 pane（右面板「浏览器」tab 的 iframe 预览工具设置）
// ──────────────────────────────────────────────────────────────
// 三项配置写穿透 SQLite app_settings 的 browser 分组（settings-store），
// 由 components/dev/browser-pane.tsx 真实消费：
// - defaultDevicePreset / defaultZoom：pane 挂载初值（工具栏内临时改动不写回）
// - strictSandbox：安全策略，每次渲染生效（切换即重新挂载预览以立刻生效）
// 预设/缩放文案复用 panel.browserDevice* 既有键，避免同一概念两套译名。
// ──────────────────────────────────────────────────────────────

import { Globe } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import type { BrowserDevicePreset, BrowserZoom } from '@/stores/persistent/settings-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SegControl, SettingRow, ToggleRow } from '../settings-controls';

/** 设备预设档位（顺序即分段控件展示顺序；与 DEVICE_DIMENSIONS 键一致） */
const PRESET_STEPS: readonly { value: BrowserDevicePreset; labelKey: string }[] = [
  { value: 'responsive', labelKey: 'panel.browserDeviceResponsive' },
  { value: 'desktop', labelKey: 'panel.browserDeviceDesktop' },
  { value: 'laptop', labelKey: 'panel.browserDeviceLaptop' },
  { value: 'tablet', labelKey: 'panel.browserDeviceTablet' },
  { value: 'mobile', labelKey: 'panel.browserDeviceMobile' },
];

/** 缩放档位（百分比；与 pane 工具栏下拉同源，避免两处漂移） */
const ZOOM_STEPS: readonly BrowserZoom[] = [50, 75, 100, 125, 150, 200];

/** 浏览器 pane */
export function BrowserSection(): ReactElement {
  const { t } = useTranslation();
  const browser = useSettingsStore((s) => s.browser);
  const updateBrowser = useSettingsStore((s) => s.updateBrowser);

  const handlePresetChange = (value: string): void => {
    const next = PRESET_STEPS.find((step) => step.value === value);
    if (next !== undefined) {
      updateBrowser({ defaultDevicePreset: next.value });
    }
  };

  const handleZoomChange = (value: string): void => {
    const next = ZOOM_STEPS.find((zoom) => String(zoom) === value);
    if (next !== undefined) {
      updateBrowser({ defaultZoom: next });
    }
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
          options={PRESET_STEPS.map((step) => ({
            value: step.value,
            label: t(step.labelKey),
          }))}
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
        onChange={(checked) => updateBrowser({ strictSandbox: checked })}
      />
    </div>
  );
}
