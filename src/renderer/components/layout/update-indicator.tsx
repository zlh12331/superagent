import { Loader2, PackageCheck } from 'lucide-react';
import { type ReactElement, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useInstallUpdate } from '@/hooks/use-install-update';
import { useUpdate } from '@/hooks/use-update';
import { useTranslation } from '@/i18n/use-translation';
import { cn } from '@/lib/utils';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';

/**
 * 顶栏更新指示
 *
 * @example
 * ```tsx
 * // Topbar 右侧按钮簇内挂载（全局单实例）
 * <UpdateIndicator />
 * ```
 */
export function UpdateIndicator(): ReactElement | null {
  const { state } = useUpdate();
  const installUpdate = useInstallUpdate();
  const openSettings = useUiStore((s) => s.openSettings);
  const { t } = useTranslation();
  const skippedVersion = useSettingsStore((s) => s.update.skippedVersion);
  const setUpdate = useSettingsStore((s) => s.setUpdate);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);

  const phase = state?.phase;
  const version = state?.version ?? '';
  const iconButtonClass = cn(
    'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground size-8',
  );

  if (phase === 'downloading') {
    const percent = Math.round(state?.progress ?? 0);
    const label = t('update.indicatorDownloading', { percent: String(percent) });
    return (
      <Button
        variant="ghost"
        size="icon"
        className={cn(iconButtonClass, 'gap-0 text-2xs tabular-nums')}
        aria-label={label}
        title={label}
        onClick={() => openSettings('about')}
      >
        <Loader2 className="size-4 animate-spin" strokeWidth={1.5} />
      </Button>
    );
  }

  const silenced = version !== '' && (version === skippedVersion || version === dismissedVersion);
  if (phase === 'downloaded' && !silenced) {
    const label = t('update.indicatorReady', { version });
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className={cn(iconButtonClass, 'relative')}
            aria-label={label}
            title={label}
          >
            <PackageCheck className="text-accent-text size-4" strokeWidth={1.5} />
            <span
              className="bg-accent absolute top-1.5 right-1.5 size-1.5 rounded-full"
              aria-hidden
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => void installUpdate()}>
            {t('update.restartNow')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setDismissedVersion(version)}>
            {t('update.later')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setUpdate({ skippedVersion: version })}>
            {t('update.skipVersion')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  return null;
}
