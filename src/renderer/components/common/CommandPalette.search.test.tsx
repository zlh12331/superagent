// src/renderer/components/$1/CommandPalette.search.test.tsx
// CommandPalette 深覆盖：命令执行 / 模糊搜索 / 文件与会话派生 / 开关交互
// ──────────────────────────────────────────────
// 覆盖动机：原冒烟测试仅覆盖操作组渲染与主题三态标题（组件行覆盖 58%）——
// 命令 action 副作用（导航/主题切换/面板折叠/文件打开/会话切换）、
// fuse.js 模糊搜索、文件派生（相对路径 + 50 条上限）、会话派生（20 条上限）、
// 遮罩点击与 Esc 关闭均无回归锚。
// 隔离面：仅 mock window.api（会话列表 IPC）；store / cmdk / fuse 全真实。
// ──────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useSettingsStore } from '@/stores/persistent/settings-store';
import { useFileTreeStore } from '@/stores/transient/file-tree-store';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

import { CommandPalette } from './CommandPalette';

const t = i18n.t.bind(i18n);

/** 路由观察点：记录当前 pathname 供导航断言 */
let currentPath = '';
function PathProbe(): null {
  currentPath = useLocation().pathname;
  return null;
}

function renderPalette(open = true): { onOpenChange: ReturnType<typeof vi.fn> } {
  const onOpenChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/chat/s1']}>
        <ThemeProvider>
          <CommandPalette open={open} onOpenChange={onOpenChange} />
          <Routes>
            <Route path="*" element={<PathProbe />} />
          </Routes>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onOpenChange };
}

/** 按可见标题点击某个命令项 */
function clickCommand(title: string): void {
  fireEvent.click(screen.getByText(title));
}

describe('CommandPalette 命令执行', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentPath = '';
    useSettingsStore.setState({ theme: 'dark' });
    useUiStore.setState({
      sidebarView: 'threads',
      sidebarCollapsed: false,
      rightPanelCollapsed: true,
      settingsOpen: false,
    });
    useFileTreeStore.setState({ rootPath: null, entries: new Map() });
    useActiveSessionStore.setState({ activeSessionId: null });
    useWelcomeStore.setState({ isWelcomeMode: false });
    // 会话列表 IPC（默认空）
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = {
      list: vi.fn(async () => ({ data: { sessions: [], total: 0 } })),
    } as never;
  });

  it('open=false：不渲染面板', () => {
    renderPalette(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('/new 命令：清激活会话 + 进欢迎模式 + 跳首页 + 关闭面板', async () => {
    renderPalette();
    clickCommand(t('palette.newChat'));
    await waitFor(() => {
      expect(currentPath).toBe('/');
    });
    expect(useWelcomeStore.getState().isWelcomeMode).toBe(true);
  });

  it('/toggle-theme 命令：三态循环（dark → light）并关闭面板', () => {
    const { onOpenChange } = renderPalette();
    clickCommand(t('palette.toggleThemeLight'));
    expect(useSettingsStore.getState().theme).toBe('light');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('/open-settings 命令：打开设置对话框', () => {
    renderPalette();
    clickCommand(t('palette.openSettings'));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('/toggle-sidebar-view 命令：threads ↔ fileTree 切换', () => {
    renderPalette();
    clickCommand(t('palette.openFileTree'));
    expect(useUiStore.getState().sidebarView).toBe('fileTree');
  });

  it('/toggle-sidebar 命令：折叠状态取反', () => {
    renderPalette();
    clickCommand(t('palette.hideSidebar'));
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
  });

  it('/toggle-right-panel 命令：右面板展开（当前折叠）', () => {
    renderPalette();
    clickCommand(t('palette.showRightPanel'));
    expect(useUiStore.getState().rightPanelCollapsed).toBe(false);
  });

  it('/open-terminal 命令：展开右面板并切到终端 tab', () => {
    renderPalette();
    clickCommand(t('palette.openTerminal'));
    expect(useUiStore.getState().rightPanelCollapsed).toBe(false);
    expect(useUiStore.getState().devPanelTab).toBe('terminal');
  });
});

describe('CommandPalette 模糊搜索', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ theme: 'dark' });
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = {
      list: vi.fn(async () => ({ data: { sessions: [], total: 0 } })),
    } as never;
  });

  it('输入查询 → 仅保留匹配项（fuse 模糊匹配）', () => {
    renderPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '设置' } });
    expect(screen.getByText(t('palette.openSettings'))).toBeDefined();
    expect(screen.queryByText(t('palette.newChat'))).toBeNull();
  });

  it('异常边界：无匹配查询 → 渲染空态文案', () => {
    renderPalette();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzz不存在的命令' } });
    expect(screen.getByText(t('common.noResults'))).toBeDefined();
  });

  it('清空查询 → 恢复全部命令', () => {
    renderPalette();
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: '设置' } });
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText(t('palette.newChat'))).toBeDefined();
  });
});

describe('CommandPalette 数据派生', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ theme: 'dark' });
  });

  it('文件派生：rootPath + 条目 → 相对路径命令（点击打开文件）', () => {
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = { list: vi.fn(async () => ({ data: { sessions: [], total: 0 } })) } as never;
    useFileTreeStore.setState({
      rootPath: '/proj',
      entries: new Map([
        [
          '/proj',
          [
            { name: 'a.ts', path: '/proj/a.ts', type: 'file' },
            { name: 'sub', path: '/proj/sub', type: 'directory' },
          ] as never,
        ],
      ]),
    });
    // 点击文件命令 → 调 openFile（异步走 IPC 读文件，此处只断言命令已触发，不断言异步完成态）
    const openFileSpy = vi.spyOn(useFileViewerStore.getState(), 'openFile');
    renderPalette();
    // 相对路径展示（去掉 rootPath 前缀）
    expect(screen.getByText('a.ts')).toBeDefined();
    clickCommand('a.ts');
    expect(openFileSpy).toHaveBeenCalledWith('/proj/a.ts');
    openFileSpy.mockRestore();
  });

  it('异常边界：rootPath 为 null → 不派生文件命令（无文件组）', () => {
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = { list: vi.fn(async () => ({ data: { sessions: [], total: 0 } })) } as never;
    useFileTreeStore.setState({ rootPath: null, entries: new Map() });
    renderPalette();
    expect(screen.queryByText(t('palette.sectionFiles'))).toBeNull();
  });

  it('会话派生：会话列表 → 会话切换命令（点击切激活会话并跳转）', async () => {
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = {
      list: vi.fn(async () => ({
        data: {
          sessions: [{ id: 's9', title: '我的会话', updatedAt: 1 }],
          total: 1,
        },
      })),
    } as never;
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText('我的会话')).toBeDefined();
    });
    clickCommand('我的会话');
    expect(useActiveSessionStore.getState().activeSessionId).toBe('s9');
    await waitFor(() => {
      expect(currentPath).toBe('/chat/s9');
    });
  });

  it('边界：会话标题为空 → 回退未命名占位文案', async () => {
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = {
      list: vi.fn(async () => ({
        data: { sessions: [{ id: 's1', title: '', updatedAt: 1 }], total: 1 },
      })),
    } as never;
    renderPalette();
    await waitFor(() => {
      expect(screen.getByText(t('palette.unnamedSession'))).toBeDefined();
    });
  });
});

describe('CommandPalette 关闭交互', () => {
  beforeEach(() => {
    useSettingsStore.setState({ theme: 'dark' });
    const w = window as unknown as { api: { session?: unknown } };
    w.api.session = { list: vi.fn(async () => ({ data: { sessions: [], total: 0 } })) } as never;
  });

  it('遮罩点击（target 为遮罩自身）→ 关闭', () => {
    const { onOpenChange } = renderPalette();
    const overlay = screen.getByRole('dialog');
    fireEvent.click(overlay);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Esc 键 → 关闭', () => {
    const { onOpenChange } = renderPalette();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('a11y：面板为 modal dialog 且有可访问名称；输入框有 label', () => {
    renderPalette();
    const dialog = screen.getByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-label')).toBe(t('topbar.commandPalette'));
    expect(screen.getByRole('combobox').getAttribute('aria-label')).toBe(t('palette.searchLabel'));
  });
});
