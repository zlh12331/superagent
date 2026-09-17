// src/renderer/components/layout/sidebar-account.test.tsx
// 侧栏账户区测试（正向 / 边界 / 异常）：触发器 / 设置入口 / 语言子菜单 /
// 主题三态子菜单 / 报告问题 IPC 守卫
// ──────────────────────────────────────────────────────────────
// mock 边界：changeLanguage（i18next 全局副作用）mock 化以断言调用并避免
// 污染测试进程语言状态；SUPPORTED_LANGUAGES 保留真实导出。
// ThemeProvider / settings-store / ui-store 走真实实现。
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useUiStore } from '@/stores/transient/ui-store';

import { SidebarAccount } from './sidebar-account';

// changeLanguage mock 化：避免测试进程真实切换 i18next 语言；SUPPORTED_LANGUAGES 保留真实导出
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
    // jsdom 无法可靠驱动 Radix 子菜单项的 select（父层 pointerdown 判定）；
    // 选择处理是 changeLanguage + settings-store.setLanguage 的两行薄委托，
    // 语义由语言切换测试（general-section）与主题测试共同兜底。此处锁定子菜单结构。
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
    // 先留存 spy 引用：删除 api 后 handler 读到 undefined 即提前 return，spy 作"未被触达"见证
    const openExternal = window.api.app.openExternal;
    (window as unknown as { api: undefined }).api = undefined;

    // 守卫缺失时读取 window.api.app 会抛 TypeError（jsdom 把监听器内抛错派发为 window error 事件）
    const uncaught: unknown[] = [];
    const onError = (event: ErrorEvent): void => {
      uncaught.push(event.error);
      event.preventDefault(); // 落袋后不再上报进程级，避免 run 整体失败盖过本断言
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
    // 子菜单未展开前，主题子触发器已按当前主题渲染 Moon 图标
    fireEvent.keyDown(screen.getByLabelText(t('sidebar.accountMenu')), { key: 'ArrowDown' });
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(document.querySelector('.lucide-moon')).not.toBeNull();
  });
});
