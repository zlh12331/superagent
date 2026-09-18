// src/renderer/components/settings/sections/data-section.test.tsx
// DataSection 测试（正向 / 边界 / 异常）：导出会话 / 打开数据目录，含 IPC 与用户取消分支
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, warning: vi.fn() },
}));

import { DataSection } from './data-section';

const t = i18n.t.bind(i18n);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DataSection', () => {
  it('正向：导出成功 → 成功提示（含路径）', async () => {
    window.api = {
      session: {
        exportAll: vi.fn().mockResolvedValue({ data: { saved: true, path: '/tmp/a.zip' } }),
      },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));

    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        t('settings.exportSuccess', { path: '/tmp/a.zip' }),
      ),
    );
  });

  it('边界：用户取消（saved=false）→ 静默，不提示成功也不报错', async () => {
    window.api = {
      session: { exportAll: vi.fn().mockResolvedValue({ data: { saved: false } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));

    await waitFor(() => expect(window.api.session.exportAll).toHaveBeenCalled());
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();
  });

  it('异常：导出失败（错误信封）→ 失败提示', async () => {
    window.api = {
      session: { exportAll: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'no' } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(t('settings.exportFailed')));
  });

  it('正向：打开数据目录 ok=true → 成功提示', async () => {
    window.api = {
      app: { openDataDir: vi.fn().mockResolvedValue({ data: { ok: true } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.openDataDir') }));

    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith(t('settings.dataDirOpened')));
  });

  it('异常：打开数据目录 ok=false → 失败提示', async () => {
    window.api = {
      app: { openDataDir: vi.fn().mockResolvedValue({ data: { ok: false } }) },
    } as never;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.openDataDir') }));

    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith(t('settings.exportFailed')));
  });

  it('边界：浏览器模式（无桥）→ 不调 IPC、不抛错、无提示', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    render(<DataSection />);

    await userEvent.click(screen.getByRole('button', { name: t('settings.exportSessions') }));
    await userEvent.click(screen.getByRole('button', { name: t('settings.openDataDir') }));

    expect(mockToastError).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  describe('更新缓存', () => {
    it('正向：展示占用并清理（确认后刷新为 0）', async () => {
      const getCacheInfo = vi
        .fn()
        .mockResolvedValue({ data: { path: '/tmp/app-updater', bytes: 1048576, fileCount: 2 } });
      const clearCache = vi
        .fn()
        .mockResolvedValue({ data: { path: '/tmp/app-updater', bytes: 0, fileCount: 0 } });
      window.api = { update: { getCacheInfo, clearCache } } as never;
      render(<DataSection />);

      // 占用文案（1.0 MB / 2 个文件）
      await waitFor(() => expect(screen.getByText(/1\.0 MB/)).toBeTruthy());

      await userEvent.click(screen.getByRole('button', { name: t('settings.clearUpdateCache') }));
      // 危险操作先确认：沿用 confirm store（DialogHost 未挂载 → 需手动放行）
      const { useConfirmDialogStore } = await import('@/stores/transient/confirm-dialog-store');
      await waitFor(() => expect(useConfirmDialogStore.getState().currentRequest).not.toBeNull());
      useConfirmDialogStore.getState()._resolve(true);

      await waitFor(() => expect(clearCache).toHaveBeenCalledOnce());
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith(t('settings.clearUpdateCacheDone')),
      );
    });

    it('边界：无法解析缓存目录（path 为 null）→ 隐藏该行，不展示猜测值', async () => {
      window.api = {
        update: {
          getCacheInfo: vi.fn().mockResolvedValue({ data: { path: null, bytes: 0, fileCount: 0 } }),
          clearCache: vi.fn(),
        },
      } as never;
      render(<DataSection />);

      await waitFor(() => expect(window.api.update.getCacheInfo).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: t('settings.clearUpdateCache') })).toBeNull();
    });
  });
});
