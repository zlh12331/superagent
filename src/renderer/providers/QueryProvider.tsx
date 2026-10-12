import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { queryClient } from '@/lib/query/query-client';

/** Devtools 面板模块类型（仅 dev 经动态 import 可达；生产构建整体 DCE 不可达） */
type DevtoolsModule = typeof import('./query-devtools');

/**
 * TanStack Query Provider
 *
 * 在 AppProviders 中包裹一次即可，业务组件直接用 useQuery / useMutation。
 *
 * @example
 * ```tsx
 * // 业务 hook 中
 * const { data: files } = useQuery({
 *   queryKey: ['files', projectId],
 *   queryFn: () => window.api.invoke('files:get', projectId),
 * });
 * ```
 */
export function QueryProvider({ children }: { children: ReactNode }): ReactElement {
  const [devtoolsModule, setDevtoolsModule] = useState<DevtoolsModule | null>(null);

  useEffect(() => {
    if (import.meta.env.DEV && import.meta.env.MODE !== 'web' && !import.meta.env['VITEST']) {
      void import('./query-devtools').then(setDevtoolsModule);
    }
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      {devtoolsModule ? <devtoolsModule.QueryDevtools /> : null}
    </QueryClientProvider>
  );
}
