import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { SectionTitle, ToggleRow } from '../settings-controls';

/**
 * 实验功能 pane
 */
export function ExperimentalSection(): ReactElement {
  const { t } = useTranslation();
  const experimental = useSettingsStore((s) => s.experimental);
  const updateExperimental = useSettingsStore((s) => s.updateExperimental);

  return (
    <div className="flex flex-col gap-2">
      <SectionTitle>{t('settings.experimental.title')}</SectionTitle>
      <p className="text-muted-foreground text-xs leading-[1.5]">
        {t('settings.experimental.hint')}
      </p>

      <ToggleRow
        name={t('settings.experimental.scanlines')}
        description={t('settings.experimental.scanlinesDesc')}
        checked={experimental.scanlines}
        onChange={(checked) => updateExperimental({ scanlines: checked })}
      />
      <ToggleRow
        name={t('settings.experimental.reasoningCollapsed')}
        description={t('settings.experimental.reasoningCollapsedDesc')}
        checked={experimental.reasoningCollapsed}
        onChange={(checked) => updateExperimental({ reasoningCollapsed: checked })}
      />
      <ToggleRow
        name={t('settings.experimental.autoCompact')}
        description={t('settings.experimental.autoCompactDesc')}
        checked={experimental.autoCompact}
        onChange={(checked) => updateExperimental({ autoCompact: checked })}
      />
    </div>
  );
}
