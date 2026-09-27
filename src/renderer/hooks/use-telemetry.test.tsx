// src/renderer/hooks/use-telemetry.test.tsx
// Telemetry level hooks: query degradation / mutation cache invalidation / no-bridge

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ipcErr, ipcOk } from '@/lib/ipc-factories';

import {
  TELEMETRY_LEVEL_QUERY_KEY,
  useSetTelemetryLevel,
  useTelemetryLevelQuery,
} from './use-telemetry';

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { wrapper, queryClient };
}

function mockSettingsApi(impl: Record<string, ReturnType<typeof vi.fn>>): void {
  (window.api as unknown as Record<string, Record<string, unknown>>)['settings'] = {
    ...((window.api as unknown as Record<string, Record<string, unknown>>)['settings'] as Record<
      string,
      unknown
    >),
    ...impl,
  };
}

function removeBridge(): void {
  (window as unknown as { api: undefined }).api = undefined;
}

describe('use-telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('useTelemetryLevelQuery', () => {
    it('bridge success returns level string', async () => {
      mockSettingsApi({ getTelemetryLevel: vi.fn(async () => ipcOk({ level: 'error-only' })) });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useTelemetryLevelQuery(), { wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBe('error-only');
    });

    it('no bridge degrades to off', async () => {
      removeBridge();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useTelemetryLevelQuery(), { wrapper });
      await waitFor(() => expect(result.current.data).toBe('off'));
    });
  });

  describe('useSetTelemetryLevel', () => {
    it('success invalidates level query', async () => {
      mockSettingsApi({
        getTelemetryLevel: vi.fn(async () => ipcOk({ level: 'off' })),
        setTelemetryLevel: vi.fn(async () => ipcOk({ ok: true, level: 'full' })),
      });
      const { wrapper, queryClient } = createWrapper();
      const spy = vi.spyOn(queryClient, 'invalidateQueries');
      const { result } = renderHook(() => useSetTelemetryLevel(), { wrapper });
      result.current.mutate('full');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(spy).toHaveBeenCalledWith({ queryKey: TELEMETRY_LEVEL_QUERY_KEY });
    });

    it('no bridge throws and toasts error', async () => {
      removeBridge();
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSetTelemetryLevel(), { wrapper });
      result.current.mutate('full');
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(toast.error).toHaveBeenCalled();
    });

    it('IPC error response is failure', async () => {
      mockSettingsApi({
        setTelemetryLevel: vi.fn(async () => ipcErr('SETTINGS_WRITE_FAILED', 'disk full')),
      });
      const { wrapper } = createWrapper();
      const { result } = renderHook(() => useSetTelemetryLevel(), { wrapper });
      result.current.mutate('error-only');
      await waitFor(() => expect(result.current.isError).toBe(true));
    });
  });
});
