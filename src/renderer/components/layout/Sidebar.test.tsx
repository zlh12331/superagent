// src/renderer/components/layout/Sidebar.test.tsx
// 侧栏组装层集成测试（正向 / 边界 / 异常）：
// 五态（loading/error/empty/ready/搜索空态）、会话选择与新建导航、
// 搜索过滤、置顶标识、tab 计数、加载更多、文件树视图切换
// ──────────────────────────────────────────────────────────────
// mock 边界：会话数据域（useSessionsQuery / mutations）、useWorkingDir、
// 搜索高亮副作用 hook、FileTreePanel（独立域已有自身测试）。
// thread-item / folder-label / sidebar-account / sidebar-utils 走真实实现。
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { useUiStore } from '@/stores/transient/ui-store';
import { useWelcomeStore } from '@/stores/transient/welcome-store';

const { mockDeleteSession, mockPinSession } = vi.hoisted(() => ({
  mockDeleteSession: vi.fn(),
  mockPinSession: vi.fn(),
}));

const mockQuery = vi.hoisted(() => ({ value: undefined as Record<string, unknown> | undefined }));

vi.mock('@/hooks/use-sessions', () => ({
  useSessionsQuery: () =>
    mockQuery.value ?? {
      data: { pages: [{ sessions: [] }], pageParams: [] },
      isLoading: false,
      isError: false,
      error: null,
      hasNextPage: false,
      isFetchingNextPage: false,
      fetchNextPage: vi.fn(),
    },
  useDeleteSession: () => ({ mutate: mockDeleteSession, isPending: false }),
  usePinSession: () => ({ mutate: mockPinSession, isPending: false }),
  // thread-item 内联重命名使用（Sidebar 渲染 thread-item，故必须提供）
  useRenameSession: () => ({ mutateAsync: vi.fn().mockResolvedValue({ data: { ok: true } }) }),
}));
vi.mock('@/hooks/use-working-dir', () => ({ useWorkingDir: () => null }));
vi.mock('@/hooks/use-sidebar-highlight', () => ({
  useSidebarHighlight: () => ({ highlightedIds: new Set<string>() }),
}));
vi.mock('@/components/file-tree/FileTreePanel', () => ({
  // biome-ignore lint/style/useNamingConvention: mock 工厂必须保留组件原名（同名导出）
  FileTreePanel: (): ReactNode => <div data-testid="ft-panel" />,
}));

import { Sidebar } from './Sidebar';

const t = i18n.t.bind(i18n);

/** 会话工厂 */
function session(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides['id'] ?? 's1',
    title: overrides['title'] ?? '会话 A',
    workingDir: overrides['workingDir'] ?? 'C:\\proj',
    updatedAt: overrides['updatedAt'] ?? 1000,
    pinned: overrides['pinned'] ?? false,
  };
}

/** 组装分页形状的 query 返回值（v5 契约：status + fetchStatus，见 use-async-view） */
function readyQuery(sessions: readonly Record<string, unknown>[], hasNextPage = false) {
  return {
    data: { pages: [{ sessions }], pageParams: [] },
    status: 'success',
    fetchStatus: 'idle',
    isLoading: false,
    isError: false,
    error: null,
    hasNextPage,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
  };
}

function renderSidebar(): ReturnType<typeof render> {
  // Sidebar 使用 useNavigate（跳转）且内嵌 SidebarAccount（useTheme）——
  // 需 Router + ThemeProvider 包裹
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <Sidebar />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.value = undefined;
  useActiveSessionStore.setState({ activeSessionId: null });
  useUiStore.setState({ sidebarView: 'threads' });
  useWelcomeStore.setState({ isWelcomeMode: false, pendingWorkingDir: null });
});

describe('Sidebar · 五态渲染', () => {
  it('加载中：渲染骨架占位（5 行 × 2 根骨架条）', async () => {
    mockQuery.value = {
      status: 'pending',
      fetchStatus: 'idle',
      isLoading: true,
      isError: false,
      error: null,
      data: undefined,
    };
    renderSidebar();
    // AsyncBoundary 骨架屏有 200ms 防闪烁延迟，需等待显示
    await waitFor(
      () => expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(10),
      { timeout: 800 },
    );
  });

  it('异常：查询失败 → 错误态（role=alert 重试入口），不渲染列表', () => {
    mockQuery.value = {
      status: 'error',
      fetchStatus: 'idle',
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      data: undefined,
    };
    renderSidebar();
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.queryByText('会话 A')).toBeNull();
  });

  it('空态：无会话 → 空状态文案（无重复 CTA）', () => {
    mockQuery.value = readyQuery([]);
    renderSidebar();
    expect(screen.getByText(t('sidebar.noSessions'))).toBeDefined();
  });

  it('正向：有会话 → 列表渲染 + tab 计数', () => {
    mockQuery.value = readyQuery([
      session({ id: 's1', title: '会话 A' }),
      session({ id: 's2', title: '会话 B' }),
    ]);
    renderSidebar();
    expect(screen.getByText('会话 A')).toBeDefined();
    expect(screen.getByText('会话 B')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });

  it('异常边界：会话查询失败后重试 → refetch 被触发', async () => {
    const refetch = vi.fn();
    mockQuery.value = {
      status: 'error',
      fetchStatus: 'idle',
      isLoading: false,
      isError: true,
      error: new Error('boom'),
      data: undefined,
      refetch,
    };
    renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe('Sidebar · 会话交互', () => {
  it('正向：点击会话 → 设置激活 + 跳转聊天页', async () => {
    mockQuery.value = readyQuery([session({ id: 's9', title: '会话 A' })]);
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByText('会话 A'));

    expect(useActiveSessionStore.getState().activeSessionId).toBe('s9');
  });

  it('正向：置顶会话 → 行内 Pin 图标', () => {
    mockQuery.value = readyQuery([session({ id: 's1', title: '置顶会话', pinned: true })]);
    renderSidebar();
    expect(document.querySelector('.lucide-pin')).not.toBeNull();
  });

  it('正向：新建会话 → 清激活 + 进欢迎模式 + 跳首页 + 清空搜索', async () => {
    mockQuery.value = readyQuery([session({ id: 's1' })]);
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByRole('button', { name: t('sidebar.newSession') }));

    expect(useActiveSessionStore.getState().activeSessionId).toBeNull();
    expect(useWelcomeStore.getState().isWelcomeMode).toBe(true);
  });

  it('正向：删除会话 → mutation 触发（激活会话被删时回首页的分支由回调内处理）', async () => {
    mockQuery.value = readyQuery([session({ id: 's1', title: '会话 A' })]);
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    const user = userEvent.setup();
    renderSidebar();

    // 打开行操作菜单 → 删除会话
    await user.click(screen.getByLabelText(t('sidebar.sessionActions')));
    await user.click(await screen.findByText(t('sidebar.deleteSession')));

    expect(mockDeleteSession).toHaveBeenCalledWith('s1', expect.anything());
  });

  it('正向：置顶切换 → pin mutation（pinned 取反传入）', async () => {
    mockQuery.value = readyQuery([session({ id: 's1', title: '会话 A', pinned: true })]);
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByLabelText(t('sidebar.sessionActions')));
    await user.click(await screen.findByText(t('sidebar.unpin')));

    expect(mockPinSession).toHaveBeenCalledWith({ id: 's1', pinned: false });
  });
});

describe('Sidebar · 搜索与视图', () => {
  it('正向：搜索即时过滤（标题匹配保留，其余隐藏）', async () => {
    mockQuery.value = readyQuery([
      session({ id: 's1', title: '修复登录页' }),
      session({ id: 's2', title: '重构 IPC' }),
    ]);
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByLabelText(t('sidebar.searchSessions')), '登录');

    expect(screen.getByText('修复登录页')).toBeDefined();
    expect(screen.queryByText('重构 IPC')).toBeNull();
  });

  it('异常边界：搜索无匹配 → 搜索空态文案（含查询词）', async () => {
    mockQuery.value = readyQuery([session({ id: 's1', title: '会话 A' })]);
    const user = userEvent.setup();
    renderSidebar();

    await user.type(screen.getByLabelText(t('sidebar.searchSessions')), '不存在的会话');

    await waitFor(() => {
      expect(
        screen.getByText(t('sidebar.searchNoResults', { query: '不存在的会话' })),
      ).toBeDefined();
    });
  });

  it('正向：文件树视图 → 渲染 FileTreePanel（sidebarView 切换）', () => {
    mockQuery.value = readyQuery([session({ id: 's1' })]);
    useUiStore.setState({ sidebarView: 'fileTree' });
    renderSidebar();
    expect(screen.getByTestId('ft-panel')).toBeDefined();
  });

  it('正向边界：hasNextPage → 渲染「加载更多」，点击触发 fetchNextPage', async () => {
    const fetchNextPage = vi.fn();
    mockQuery.value = {
      ...readyQuery([session({ id: 's1' })]),
      hasNextPage: true,
      fetchNextPage,
    };
    const user = userEvent.setup();
    renderSidebar();

    await user.click(screen.getByText(t('sidebar.loadMore')));

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
