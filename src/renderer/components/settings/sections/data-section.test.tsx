// src/renderer/components/settings/sections/data-section.test.tsx
// DataSection 测试（正向 / 边界 / 异常）：会话导出/导入 + 设置导出/导入 +
// 打开数据目录，含 IPC、用户取消与确认分支
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

import { useSettingsStore } from '@/stores/persistent/settings-store';
import { DataSection } from './data-section';

const t = i18n.t.bind(i18n);

beforeEach(() => {
  vi.clearAllMocks();
});

/** 点击按钮 → 放行 confirm store（DialogHost 未挂载，手动 resolve） */
async function clickWithConfirm(name: string, result: boolean): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name }));
  const { useConfirmDialogStore } = await import('@/stores/transient/confirm-dialog-store');
  await waitFor(() => expect(useConfirmDialogStore.getState().currentRequest).not.toBeNull());
  useConfirmDialogStore.getState()._resolve(result);
}

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

  describe('会话导入', () => {
    it('正向：确认后导入 → 成功提示（含 imported/skipped 计数）', async () => {
      window.api = {
        session: { importAll: vi.fn().mockResolvedValue({ data: { imported: 2, skipped: 1 } }) },
      } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.importSessions'), true);

      await waitFor(() => expect(window.api.session.importAll).toHaveBeenCalled());
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith(
          t('settings.importSessionsDone', { imported: 2, skipped: 1 }),
        ),
      );
    });

    it('边界：确认弹窗取消 → 不调 IPC', async () => {
      window.api = { session: { importAll: vi.fn() } } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.importSessions'), false);

      expect(window.api.session.importAll).not.toHaveBeenCalled();
    });

    it('异常：导入失败（错误信封）→ 失败提示', async () => {
      window.api = {
        session: { importAll: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'no' } }) },
      } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.importSessions'), true);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(t('settings.importSessionsFailed')),
      );
    });
  });

  describe('设置导出/导入', () => {
    it('正向：导出设置成功 → 成功提示（含路径）', async () => {
      window.api = {
        settings: {
          exportSettings: vi.fn().mockResolvedValue({ data: { saved: true, path: '/a.json' } }),
        },
      } as never;
      render(<DataSection />);

      await userEvent.click(screen.getByRole('button', { name: t('settings.exportSettings') }));

      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith(
          t('settings.exportSuccess', { path: '/a.json' }),
        ),
      );
    });

    it('异常：导出设置失败 → 失败提示', async () => {
      window.api = {
        settings: {
          exportSettings: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'no' } }),
        },
      } as never;
      render(<DataSection />);

      await userEvent.click(screen.getByRole('button', { name: t('settings.exportSettings') }));

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(t('settings.exportSettingsFailed')),
      );
    });

    it('正向：导入设置（覆盖类，确认标红后执行）→ 成功提示（含计数）', async () => {
      window.api = {
        settings: {
          importSettings: vi.fn().mockResolvedValue({ data: { imported: 3, skipped: 0 } }),
        },
      } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.importSettings'), true);

      await waitFor(() => expect(window.api.settings.importSettings).toHaveBeenCalled());
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith(
          t('settings.importSettingsDone', { imported: 3, skipped: 0 }),
        ),
      );
    });

    it('边界：导入设置确认取消 → 不调 IPC', async () => {
      window.api = { settings: { importSettings: vi.fn() } } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.importSettings'), false);

      expect(window.api.settings.importSettings).not.toHaveBeenCalled();
    });

    it('异常：导入设置失败 → 失败提示', async () => {
      window.api = {
        settings: {
          importSettings: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'no' } }),
        },
      } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.importSettings'), true);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(t('settings.importSettingsFailed')),
      );
    });

    it('正向：恢复默认设置（确认后）→ store 全量回落默认 + 成功提示', async () => {
      // 预置非默认值：重置后必须回到 DEFAULT_SETTINGS
      useSettingsStore.setState({
        theme: 'light',
        ai: { ...useSettingsStore.getState().ai, temperature: 1.5, systemPrompt: 'custom' },
      });
      window.api = {
        settings: { resetAll: vi.fn().mockResolvedValue({ data: { settings: {} } }) },
      } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.resetAllSettings'), true);

      await waitFor(() => expect(window.api.settings.resetAll).toHaveBeenCalled());
      await waitFor(() =>
        expect(mockToastSuccess).toHaveBeenCalledWith(t('settings.resetAllSettingsDone')),
      );
      // store 已全量回落默认（applySettingsSnapshot({}) 语义）
      expect(useSettingsStore.getState().theme).toBe('dark');
      expect(useSettingsStore.getState().ai.temperature).toBe(0.7);
      expect(useSettingsStore.getState().ai.systemPrompt).toBe('');
    });

    it('边界：恢复默认确认取消 → 不调 IPC', async () => {
      window.api = { settings: { resetAll: vi.fn() } } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.resetAllSettings'), false);

      expect(window.api.settings.resetAll).not.toHaveBeenCalled();
    });

    it('异常：恢复默认失败 → 失败提示', async () => {
      window.api = {
        settings: { resetAll: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'no' } }) },
      } as never;
      render(<DataSection />);

      await clickWithConfirm(t('settings.resetAllSettings'), true);

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith(t('settings.resetAllSettingsFailed')),
      );
    });
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
