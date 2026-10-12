import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';

import { SidebarAccount } from './sidebar-account';

vi.mock('@/i18n/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/i18n/config')>()),
  changeLanguage: vi.fn(),
}));

const t = i18n.t.bind(i18n);

function renderAccount() {
  return render(
    <ThemeProvider>
      <SidebarAccount />
    </ThemeProvider>,
  );
}

async function openMenu(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(t('sidebar.accountMenu')));
  await screen.findByText(t('topbar.settings'));
}

beforeEach(() => {
  vi.clearAllMocks();
  useSettingsStore.setState({ theme: 'dark', language: 'zh-CN' });
  useUiStore.setState({ settingsOpen: false });
  window.api = {
    app: { openExternal: vi.fn().mockResolvedValue({ data: undefined }) },
  } as never;
});

describe('SidebarAccount', () => {
  it('正向：触发器渲染本地账户标识（无真实登录后端）', () => {
    renderAccount();
    expect(screen.getByText(t('sidebar.notLoggedIn'))).toBeDefined();
    expect(screen.getByText('local-user')).toBeDefined();
  });

  it('正向：菜单「设置」→ ui-store 打开全屏设置（与 Topbar 共享入口）', async () => {
    renderAccount();
    await openMenu();
    await userEvent.click(screen.getByText(t('topbar.settings')));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('正向边界：语言子菜单展开 → 双语项齐全且当前语言归一渲染', async () => {
    renderAccount();
    await openMenu();
    await userEvent.click(screen.getByText(t('sidebar.language')));

    expect(await screen.findByText('简体中文')).toBeDefined();
    expect(screen.getByText('English')).toBeDefined();
  });

  it('正向边界：主题子菜单展开 → 三档齐全（light/dark/system）', async () => {
    renderAccount();
    await openMenu();
    await userEvent.click(screen.getByText(t('sidebar.theme')));

    expect(await screen.findByText(t('sidebar.themeLight'))).toBeDefined();
    expect(screen.getByText(t('sidebar.themeDark'))).toBeDefined();
    expect(screen.getByText(t('sidebar.themeSystem'))).toBeDefined();
  });

  it('异常：浏览器模式（无桥）→ 报告问题被守卫拦截，不外发 IPC', async () => {
    const openExternal = window.api.app.openExternal;
    (window as unknown as { api: undefined }).api = undefined;

    const uncaught: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      uncaught.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', onError);

    renderAccount();
    await openMenu();
    await userEvent.click(screen.getByText(t('sidebar.reportIssue')));

    window.removeEventListener('error', onError);
    expect(uncaught).toEqual([]);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('正向：报告问题 → openExternal 打开仓库 issues 页', async () => {
    renderAccount();
    await openMenu();
    await userEvent.click(screen.getByText(t('sidebar.reportIssue')));

    await waitFor(() =>
      expect(window.api.app.openExternal).toHaveBeenCalledWith({
        url: 'https://github.com/zlh12331/superagent/issues',
      }),
    );
  });

  it('边界：主题图标随当前主题切换（dark → 子菜单触发器为 Moon）', async () => {
    renderAccount();
    await openMenu();
    fireEvent.keyDown(screen.getByLabelText(t('sidebar.accountMenu')), { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.querySelector('.lucide-moon')).not.toBeNull();
  });
});
