// telemetry-section.tsx（自 SettingsDialog 拆分）
// 设置对话框 · 遥测级别（隐私合规，对标 VS Code telemetryLevel）
// ──────────────────────────────────────────────
// 拆分背景：SettingsDialog 1052 行多域混合，按域提取为独立文件（高内聚）
// ──────────────────────────────────────────────

import type { TelemetryLevel } from '@code-agent/shared/renderer';
import { Shield } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useSetTelemetryLevel, useTelemetryLevelQuery } from '@/hooks/use-telemetry';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';

/** 遥测级别区块（隐私合规） */
export function TelemetrySection(): React.ReactElement {
  const { t } = useTranslation();
  const { data: telemetryLevel, isLoading: isLoadingTelemetry } = useTelemetryLevelQuery();
  const { mutate: setTelemetryLevel, isPending: isSavingTelemetry } = useSetTelemetryLevel();

  return (
    <div className="space-y-3 border-t border-border/60 pt-4">
      <div className="flex items-center gap-2">
        <Shield className="size-4 text-muted-foreground" strokeWidth={1.5} />
        <Label className="font-serif text-sm tracking-wide">{t('settings.telemetry')}</Label>
      </div>
      <p className="text-xs text-muted-foreground font-sans">{t('settings.telemetryHint')}</p>
      <div className="grid grid-cols-3 gap-1.5">
        {(
          [
            { value: 'off', label: t('settings.telOff'), desc: t('settings.telOffDesc') },
            {
              value: 'error-only',
              label: t('settings.telErrorOnly'),
              desc: t('settings.telErrorOnlyDesc'),
            },
            { value: 'full', label: t('settings.telFull'), desc: t('settings.telFullDesc') },
          ] as const
        ).map((option) => {
          const isActive = telemetryLevel === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={isSavingTelemetry || isLoadingTelemetry}
              onClick={() => setTelemetryLevel(option.value as TelemetryLevel)}
              className={cn(
                'flex flex-col items-center gap-0.5 rounded-md border px-2 py-1.5 text-center transition-colors',
                isActive
                  ? 'border-border bg-muted/60 text-foreground'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-muted',
              )}
            >
              <span className="font-serif text-xs tracking-wide">{option.label}</span>
              <span className="text-[9px] text-muted-foreground">{option.desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
