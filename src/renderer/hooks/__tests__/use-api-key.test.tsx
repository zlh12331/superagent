// src/renderer/hooks/__tests__/use-api-key.test.tsx
// use-api-key 单元测试：设置 API Key mutation
// （useApiKeyQuery / useDeleteApiKey 无生产消费方，2026-08-27 审计后已随实现移除）

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSetApiKey } from '../use-api-key';

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

/** IpcResponse 构造 */
const ok = <T,>(data: T) => ({ data });

describe('use-api-key hooks', () => {
  beforeEach(() => {
    window.api.settings = {
      getApiKey: vi.fn(),
      setApiKey: vi.fn(),
      deleteApiKey: vi.fn(),
      getTelemetryLevel: vi.fn(),
      setTelemetryLevel: vi.fn(),
    } as never;
  });

  describe('useSetApiKey', () => {
    it('成功：调用 setApiKey 并返回 ok', async () => {
      (window.api.settings.setApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ ok: true }),
      );
      const { result } = renderHook(() => useSetApiKey(), { wrapper: createWrapper() });
      result.current.mutate({ provider: 'deepseek', apiKey: 'sk-new' });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(window.api.settings.setApiKey).toHaveBeenCalledWith({
        provider: 'deepseek',
        apiKey: 'sk-new',
      });
    });
  });
});
