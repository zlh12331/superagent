import type { ReactElement, ReactNode } from 'react';

import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

import { I18nProvider } from '@/i18n';

import { QueryProvider } from './QueryProvider';
import { ThemeProvider } from './ThemeProvider';

/**
 * 应用根 Provider 组合
 *
 * 在 main.tsx / App.tsx 中包裹 <AppProviders><App /></AppProviders> 即可。
 */
export function AppProviders({ children }: { children: ReactNode }): ReactElement {
  return (
    <I18nProvider>
      <ThemeProvider>
        <QueryProvider>
          <TooltipProvider>
            {children}
            <Toaster />
          </TooltipProvider>
        </QueryProvider>
      </ThemeProvider>
    </I18nProvider>
  );
}
