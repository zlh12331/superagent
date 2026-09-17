// src/renderer/components/settings/sections/__tests__/memory-panel.test.tsx
// 记忆管理面板测试（正向 / 边界 / 异常）
// ──────────────────────────────────────────────────────────────
// 覆盖动机：该文件此前 0% 覆盖（本轮覆盖率排查确认），却是设置里交互最重的
// 面板之一（查询 + 开关 + 两级清除 + 确认弹窗 + 四态列表）。其清除路径的
// 「ok=false 必须抛错」契约此前完全靠注释维系，无回归锚：
// 主进程在引擎不可用时返回 `{ ok: false }`（不是 `{ error }`），若忘了判 ok，
// 清除失败会被渲染成「已清除」的成功提示。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';

// 仅 mock 确认弹窗（DialogHost 不在本测试渲染树内；store 层只关心 Promise 结果）
const { mockConfirm } = vi.hoisted(() => ({ mockConfirm: vi.fn(async () => true) }));
vi.mock('@/stores/transient/confirm-dialog-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/transient/confirm-dialog-store')>()),
  confirm: mockConfirm,
}));

const { mockToastError, mockToastSuccess } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
  mockToastSuccess: vi.fn(),
}));
vi.mock('sonner', () => ({
  toast: { success: mockToastSuccess, error: mockToastError, warning: vi.fn() },
}));

import { MemoryPanel } from './memory-panel';

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryPanel />
    </QueryClientProvider>,
  );
}

/** 装配 window.api.memory（list/status/clear/clearAll 均可控） */
function setupApi(
  overrides: Partial<Record<'list' | 'status' | 'clear' | 'clearAll', unknown>> = {},
) {
  const api = {
    list: vi.fn().mockResolvedValue({ data: { memories: [] } }),
    status: vi.fn().mockResolvedValue({
      data: { available: true, running: true, healthy: true, sessionCount: 0, recordCount: 0 },
    }),
    clear: vi.fn().mockResolvedValue({ data: { ok: true } }),
    clearAll: vi.fn().mockResolvedValue({ data: { ok: true, clearedSessions: 2 } }),
    ...overrides,
  };
  window.api = { memory: api } as never;
  return api;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirm.mockResolvedValue(true);
  useActiveSessionStore.setState({ activeSessionId: 's1' });
  useSettingsStore.setState((s) => ({ memory: { ...s.memory, enabled: true } }));
});

describe('MemoryPanel · 渲染与四态', () => {
  it('正向：渲染标题、隐私开关与状态条', async () => {
    setupApi({
      status: vi.fn().mockResolvedValue({
        data: { available: true, running: true, healthy: true, sessionCount: 3, recordCount: 9 },
      }),
    });
    renderPanel();

    expect(screen.getByText(i18n.t('settings.memoryTitle'))).toBeDefined();
    expect(screen.getByRole('switch', { name: i18n.t('settings.memoryEnabled') })).toBeDefined();
    await waitFor(() =>
      expect(screen.getByText(i18n.t('settings.memoryStatusRunning'))).toBeDefined(),
    );
  });

  it('正向：有记忆时渲染条目内容', async () => {
    setupApi({
      list: vi.fn().mockResolvedValue({
        data: { memories: [{ id: 1, content: '用户偏好中文回答' }] },
      }),
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText('用户偏好中文回答')).toBeDefined());
  });

  it('边界：无激活会话 → 提示先选会话（不拉列表）', async () => {
    useActiveSessionStore.setState({ activeSessionId: null });
    const api = setupApi();
    renderPanel();

    await waitFor(() => expect(screen.getByText(i18n.t('settings.memoryNoSession'))).toBeDefined());
    // enabled=false：不发起 list 请求
    expect(api.list).not.toHaveBeenCalled();
  });

  it('边界：有会话但无记忆 → 空态文案', async () => {
    setupApi();
    renderPanel();

    await waitFor(() => expect(screen.getByText(i18n.t('settings.memoryEmpty'))).toBeDefined());
  });

  it('异常：列表失败 → 错误态 + 重试入口', async () => {
    setupApi({
      list: vi.fn().mockResolvedValue({ error: { code: 'MEM_FAILED', message: 'engine down' } }),
    });
    renderPanel();

    await waitFor(() => expect(screen.getByText(/engine down/)).toBeDefined());
  });

  it('边界：状态 available=false → 「未随包提供」文案', async () => {
    setupApi({
      status: vi.fn().mockResolvedValue({
        data: { available: false, running: false, healthy: false, sessionCount: 0, recordCount: 0 },
      }),
    });
    renderPanel();

    await waitFor(() =>
      expect(screen.getByText(i18n.t('settings.memoryStatusUnavailable'))).toBeDefined(),
    );
  });
});

describe('MemoryPanel · 隐私开关', () => {
  it('切换开关 → 写入 settings-store', () => {
    setupApi();
    renderPanel();

    fireEvent.click(screen.getByRole('switch', { name: i18n.t('settings.memoryEnabled') }));

    expect(useSettingsStore.getState().memory.enabled).toBe(false);
  });
});

describe('MemoryPanel · 清除（契约：ok=false 不得当作成功）', () => {
  it('正向：清除当前会话 → 确认后调 clear + 成功提示', async () => {
    const api = setupApi({
      list: vi.fn().mockResolvedValue({ data: { memories: [{ id: 1, content: 'x' }] } }),
    });
    renderPanel();

    const btn = await screen.findByRole('button', { name: i18n.t('settings.memoryClear') });
    fireEvent.click(btn);

    await waitFor(() => expect(api.clear).toHaveBeenCalledWith({ sessionId: 's1' }));
    await waitFor(() => expect(mockToastSuccess).toHaveBeenCalled());
  });

  it('异常：ok=false（引擎不可用）→ 走失败提示，不得渲染成功', async () => {
    const api = setupApi({
      list: vi.fn().mockResolvedValue({ data: { memories: [{ id: 1, content: 'x' }] } }),
      clear: vi.fn().mockResolvedValue({ data: { ok: false } }),
    });
    renderPanel();

    const btn = await screen.findByRole('button', { name: i18n.t('settings.memoryClear') });
    fireEvent.click(btn);

    await waitFor(() => expect(api.clear).toHaveBeenCalled());
    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(i18n.t('settings.memoryClearFailed')),
    );
    expect(mockToastSuccess).not.toHaveBeenCalledWith(i18n.t('settings.memoryCleared'));
  });

  it('异常：错误信封 → 失败提示', async () => {
    setupApi({
      list: vi.fn().mockResolvedValue({ data: { memories: [{ id: 1, content: 'x' }] } }),
      clear: vi.fn().mockResolvedValue({ error: { code: 'E', message: 'nope' } }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.memoryClear') }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(i18n.t('settings.memoryClearFailed')),
    );
  });

  it('边界：确认弹窗取消 → 不调 IPC', async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const api = setupApi({
      list: vi.fn().mockResolvedValue({ data: { memories: [{ id: 1, content: 'x' }] } }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.memoryClear') }));

    await waitFor(() => expect(mockConfirm).toHaveBeenCalled());
    expect(api.clear).not.toHaveBeenCalled();
  });

  it('正向：全量清除仅在 status.sessionCount>0 时可见，且携带 clearedSessions 提示', async () => {
    const api = setupApi({
      status: vi.fn().mockResolvedValue({
        data: { available: true, running: true, healthy: true, sessionCount: 2, recordCount: 5 },
      }),
    });
    renderPanel();

    const all = await screen.findByRole('button', { name: i18n.t('settings.memoryClearAll') });
    fireEvent.click(all);

    await waitFor(() => expect(api.clearAll).toHaveBeenCalledWith({}));
    await waitFor(() =>
      expect(mockToastSuccess).toHaveBeenCalledWith(
        i18n.t('settings.memoryClearedAll', { sessions: 2 }),
      ),
    );
  });

  it('边界：sessionCount=0 → 不渲染全量清除按钮', async () => {
    setupApi();
    renderPanel();

    await waitFor(() => expect(screen.getByText(i18n.t('settings.memoryEmpty'))).toBeDefined());
    expect(screen.queryByRole('button', { name: i18n.t('settings.memoryClearAll') })).toBeNull();
  });

  it('异常：全量清除 ok=false → 失败提示', async () => {
    setupApi({
      status: vi.fn().mockResolvedValue({
        data: { available: true, running: true, healthy: true, sessionCount: 2, recordCount: 5 },
      }),
      clearAll: vi.fn().mockResolvedValue({ data: { ok: false, message: 'engine down' } }),
    });
    renderPanel();

    fireEvent.click(await screen.findByRole('button', { name: i18n.t('settings.memoryClearAll') }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(i18n.t('settings.memoryClearAllFailed')),
    );
  });
});

describe('MemoryPanel · 浏览器模式（无桥）', () => {
  it('无 window.api：列表渲染空态、状态条不渲染，且不抛错', async () => {
    (window as unknown as { api: undefined }).api = undefined;
    renderPanel();

    // 有会话但无桥 → 列表空态；状态查询返回 null → 不渲染状态条
    await waitFor(() => expect(screen.getByText(i18n.t('settings.memoryEmpty'))).toBeDefined());
    expect(screen.queryByText(i18n.t('settings.memoryStatus'))).toBeNull();
  });
});
