// src/renderer/hooks/__tests__/use-api-key.test.tsx
// use-api-key 单元测试：查询 / 设置 / 删除 API Key

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useApiKeyQuery, useDeleteApiKey, useSetApiKey } from '../use-api-key';

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
const err = (code: string, message: string) => ({ error: { code, message } });

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

  describe('useApiKeyQuery', () => {
    it('已配置：返回 true（不回传明文）', async () => {
      (window.api.settings.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ configured: true }),
      );
      const { result } = renderHook(() => useApiKeyQuery('deepseek'), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.data).toBe(true));
      expect(window.api.settings.getApiKey).toHaveBeenCalledWith({ provider: 'deepseek' });
    });

    it('未配置：返回 false', async () => {
      (window.api.settings.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ configured: false }),
      );
      const { result } = renderHook(() => useApiKeyQuery('openai'), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.data).toBe(false));
    });

    it('错误：IpcResponse.error → isError', async () => {
      (window.api.settings.getApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        err('INTERNAL_ERROR', 'boom'),
      );
      const { result } = renderHook(() => useApiKeyQuery('deepseek'), {
        wrapper: createWrapper(),
      });
      await waitFor(() => expect(result.current.isError).toBe(true));
    });
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

  describe('useDeleteApiKey', () => {
    it('成功：调用 deleteApiKey', async () => {
      (window.api.settings.deleteApiKey as ReturnType<typeof vi.fn>).mockResolvedValue(
        ok({ ok: true }),
      );
      const { result } = renderHook(() => useDeleteApiKey(), { wrapper: createWrapper() });
      // mutate 接收 provider 字符串（非对象）
      result.current.mutate('anthropic');
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(window.api.settings.deleteApiKey).toHaveBeenCalledWith({ provider: 'anthropic' });
    });
  });
});
