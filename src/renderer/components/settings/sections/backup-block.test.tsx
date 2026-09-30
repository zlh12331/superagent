// src/renderer/components/settings/sections/backup-block.test.tsx
// BackupBlock 测试（37 号 B）：列表渲染 / 立即备份 / 恢复 confirm 流
// ──────────────────────────────────────────────────────────────
// 覆盖：
// - 空态文案（无备份）
// - 列表：时间/大小/健康徽标；损坏条目恢复钮禁用
// - 立即备份：IPC 调用 + 成功 toast
// - 恢复：confirm 放行后调用 backup:restore；confirm 取消时不调用
// - 恢复失败（SESSION_IN_USE 等）→ 错误 toast（由 hook onError 弹出）
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, warning: vi.fn() },
}));

import { BackupBlock } from './backup-block';

const t = i18n.t.bind(i18n);

function renderBlock(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { readonly children: ReactNode }): ReactNode {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  render(
    <Wrapper>
      <BackupBlock />
    </Wrapper>,
  );
}

/** 点击按钮 → 放行 confirm store（DialogHost 未挂载，手动 resolve） */
async function clickWithConfirm(name: string, result: boolean): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name }));
  const { useConfirmDialogStore } = await import('@/stores/transient/confirm-dialog-store');
  await waitFor(() => expect(useConfirmDialogStore.getState().currentRequest).not.toBeNull());
  useConfirmDialogStore.getState()._resolve(result);
}

const HEALTHY_ENTRY = {
  name: 'sessions-2026-09-30T04-00-00-000.db',
  createdAtMs: Date.parse('2026-09-30T04:00:00Z'),
  sizeBytes: 8192,
  healthy: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'api', {
    value: { backup: { list: vi.fn(), create: vi.fn(), restore: vi.fn() } },
    writable: true,
    configurable: true,
  });
});

describe('BackupBlock（37-B）', () => {
  it('V1 空列表 → 空态文案', async () => {
    vi.mocked(window.api.backup.list).mockResolvedValue({ data: { backups: [] } });
    renderBlock();

    expect(await screen.findByText(t('settings.backupEmpty'))).toBeDefined();
  });

  it('V1 列表渲染：健康徽标 + 损坏条目恢复钮禁用', async () => {
    vi.mocked(window.api.backup.list).mockResolvedValue({
      data: {
        backups: [HEALTHY_ENTRY, { ...HEALTHY_ENTRY, name: 'sessions-bad.db', healthy: false }],
      },
    });
    renderBlock();

    expect(await screen.findByText(t('settings.backupHealthy'))).toBeDefined();
    expect(screen.getByText(t('settings.backupCorrupt'))).toBeDefined();
    const restoreButtons = screen.getAllByRole('button', { name: t('settings.backupRestore') });
    expect(restoreButtons).toHaveLength(2);
    expect(restoreButtons[0]).not.toBeDisabled();
    expect(restoreButtons[1]).toBeDisabled();
  });

  it('V2 立即备份：调用 IPC + 成功 toast', async () => {
    vi.mocked(window.api.backup.list).mockResolvedValue({ data: { backups: [] } });
    vi.mocked(window.api.backup.create).mockResolvedValue({ data: { name: 'sessions-new.db' } });
    renderBlock();
    await screen.findByText(t('settings.backupEmpty'));

    await userEvent.click(screen.getByRole('button', { name: t('settings.backupCreate') }));

    await waitFor(() => expect(window.api.backup.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalledWith(t('settings.backupCreated')));
  });

  it('V3/V4 恢复：confirm 放行 → 调用 restore（带裸文件名）', async () => {
    vi.mocked(window.api.backup.list).mockResolvedValue({ data: { backups: [HEALTHY_ENTRY] } });
    vi.mocked(window.api.backup.restore).mockResolvedValue({ data: { ok: true } });
    renderBlock();
    await screen.findByText(t('settings.backupHealthy'));

    await clickWithConfirm(t('settings.backupRestore'), true);

    await waitFor(() =>
      expect(window.api.backup.restore).toHaveBeenCalledWith({ name: HEALTHY_ENTRY.name }),
    );
  });

  it('边界：confirm 取消 → 不调用 restore', async () => {
    vi.mocked(window.api.backup.list).mockResolvedValue({ data: { backups: [HEALTHY_ENTRY] } });
    renderBlock();
    await screen.findByText(t('settings.backupHealthy'));

    await clickWithConfirm(t('settings.backupRestore'), false);

    expect(window.api.backup.restore).not.toHaveBeenCalled();
  });

  it('V3 异常：恢复被拒（SESSION_IN_USE）→ 错误 toast（单发）', async () => {
    vi.mocked(window.api.backup.list).mockResolvedValue({ data: { backups: [HEALTHY_ENTRY] } });
    vi.mocked(window.api.backup.restore).mockRejectedValue(
      new Error('[SESSION_IN_USE] 有回合正在运行'),
    );
    renderBlock();
    await screen.findByText(t('settings.backupHealthy'));

    await clickWithConfirm(t('settings.backupRestore'), true);

    await waitFor(() => expect(mockToastError).toHaveBeenCalledTimes(1));
  });
});
