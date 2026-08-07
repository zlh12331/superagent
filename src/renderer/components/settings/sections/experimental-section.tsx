// src/renderer/components/settings/sections/experimental-section.tsx
// 实验功能 pane（对齐原型「实验功能」设置区 + 参考 ExperimentalSettingsPane）
// ──────────────────────────────────────────────────────────────
// 诚实原则：只列真实生效的开关（消费方已接入）：
// - scanlines：扫描线视觉叠加（AppShell 根容器 class）
// - reasoningCollapsed：推理块默认折叠（message-item ReasoningBlock）
// 原型其余项（realtime-audio/remote-control/collaboration/sandbox）为参考项目
// 专有或未接入功能，不展示占位开关（避免假功能）。
// ──────────────────────────────────────────────────────────────

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
    <div className="space-y-2">
      <SectionTitle>{t('settings.experimental.title')}</SectionTitle>
      <p className="text-muted-foreground text-[11px] leading-[1.5]">
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
    </div>
  );
}
