import { BookOpenText } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from '@/i18n/use-translation';
import { MemoryPanel } from './memory-panel';

/** 规则与记忆 pane */
export function RulesMemorySection(): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-4 pt-2">
      <div>
        <div className="flex items-center gap-2">
          <BookOpenText className="text-muted-foreground size-3.5" strokeWidth={1.5} />
          <h3 className="text-foreground text-sm font-semibold">{t('settings.rulesTitle')}</h3>
        </div>
        <p className="text-muted-foreground mt-1 max-w-md text-xs leading-relaxed">
          {t('settings.rulesHint')}
        </p>
        <div className="border-border bg-muted/20 mt-2 rounded-md border px-3 py-2.5">
          <code className="text-foreground/80 font-mono text-2xs">AGENTS.md</code>
          <span className="text-muted-foreground ml-2 text-2xs">{t('settings.rulesFileHint')}</span>
        </div>
      </div>

      <MemoryPanel />
    </div>
  );
}
