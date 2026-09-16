// src/renderer/components/file-tree/__tests__/fuzzy-search-dialog.test.tsx
// FuzzySearchDialog 单元测试（对齐参考项目 FuzzySearchDialog.test.tsx 覆盖点）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 打开时显示提示（hint）
// 2. 输入关键词 → 会话结果过滤（标题匹配）
// 3. 输入关键词 → 文件结果（window.api.search.glob 返回路径，mark 高亮）
// 4. 键盘导航 ArrowDown + Enter → 选中回调 / 会话切换
// 5. 关闭回调
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActiveSessionStore } from '@/stores/persistent/sessions-store';
import { FuzzySearchDialog } from '../fuzzy-search-dialog';

const { mockToastError } = vi.hoisted(() => ({ mockToastError: vi.fn() }));

vi.mock('sonner', () => ({ toast: { error: mockToastError, success: vi.fn() } }));

function renderDialog(overrides: Partial<Parameters<typeof FuzzySearchDialog>[0]> = {}) {
  const props = {
    open: true,
    onClose: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
  render(<FuzzySearchDialog {...props} />, {
    wrapper: ({ children }: { readonly children: ReactNode }) => (
      <MemoryRouter>
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          {children}
        </QueryClientProvider>
      </MemoryRouter>
    ),
  });
  return props;
}

/**
 * 等待打开时的 rAF 重置逻辑完成（对齐参考项目测试处理方式：
 * 组件在 open 时通过 rAF 清空 query/results，需先 flush 再输入，
 * 否则 rAF 回调在 change 之后执行会把 query 清空）。
 */
async function flushOpenReset(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
}

describe('FuzzySearchDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // 会话列表 mock（useSessionsQuery 数据源）
    window.api.session = {
      list: vi.fn().mockResolvedValue({
        data: {
          sessions: [
            {
              id: 's1',
              title: '重构 IPC 定义表',
              workingDir: 'f:\\proj\\one',
              createdAt: 1,
              updatedAt: 2,
              lastMessage: undefined,
              messageCount: 3,
              pinned: false,
              lastRunStatus: 'idle',
            },
            {
              id: 's2',
              title: '修复登录页',
              workingDir: 'f:\\proj\\two',
              createdAt: 1,
              updatedAt: 2,
              lastMessage: undefined,
              messageCount: 1,
              pinned: false,
              lastRunStatus: 'idle',
            },
          ],
          total: 2,
        },
      }),
    } as never;
    // 文件搜索 mock（对齐 mock-api 行为：按查询子串过滤假文件清单）
    window.api.search = {
      glob: vi.fn().mockImplementation(async ({ pattern }: { pattern: string }) => {
        const q = pattern
          .replace(/^\*\*\/\*/, '')
          .replace(/\*$/, '')
          .replace(/\[(.)(.)\]/g, '$1')
          .toLowerCase();
        const files = ['src/App.tsx', 'src/AppShell.tsx'].filter((f) =>
          f.toLowerCase().includes(q),
        );
        return { data: { files, truncated: false } };
      }),
      grep: vi.fn(),
    } as never;
    // 激活会话清空（workingDir null → 文件搜索跳过路径不干扰会话用例）
    useActiveSessionStore.setState({ activeSessionId: null });
  });

  afterEach(async () => {
    // 在 act 内 flush 残留的 200ms 防抖定时器与异步查询
    // （否则测试结束后的异步 setState 触发 React act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
  });

  it('打开时显示搜索提示（空查询）', () => {
    renderDialog();
    expect(screen.getByText('输入关键词搜索文件或会话')).toBeInTheDocument();
  });

  it('输入关键词 → 会话标题匹配显示', async () => {
    renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '登录' } });

    // 结果断言用容器 textContent（mark 高亮会拆分标题文本节点，getByText 精确串会失败）
    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain('修复登录页');
    });
    // 不匹配的会话不显示
    expect(document.querySelector('#fuzzy-search-results')?.textContent).not.toContain(
      '重构 IPC 定义表',
    );
  });

  it('输入关键词 → 文件结果 + mark 高亮', async () => {
    // 文件搜索需要激活会话的 workingDir（对齐运行时行为：无激活会话仅会话搜索）
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'App' } });

    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain('App.tsx');
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain(
        'AppShell.tsx',
      );
    });
    // mark 高亮存在
    expect(document.querySelector('mark')).not.toBeNull();
  });

  it('键盘导航：ArrowDown 后 Enter → 选中第二个文件回调 onSelect', async () => {
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    const props = renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'App' } });

    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain('App.tsx');
    });
    // 初始选中第一个（App.tsx），ArrowDown 下移选中第二个（AppShell.tsx）
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(props.onSelect).toHaveBeenCalledWith('src/AppShell.tsx');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('Enter 直接选中第一个结果', async () => {
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    const props = renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'AppShell' } });

    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain(
        'AppShell.tsx',
      );
    });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });

    expect(props.onSelect).toHaveBeenCalledWith('src/AppShell.tsx');
  });

  it('点击文件结果 → onSelect(path) + onClose', async () => {
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    const props = renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'AppShell' } });

    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain(
        'AppShell.tsx',
      );
    });
    // 点击文件结果按钮（通过 title 属性定位：mark 拆分文本节点，getByText 不可用）
    const fileButton = [...document.querySelectorAll('#fuzzy-search-results button')].find((b) =>
      b.textContent?.includes('AppShell.tsx'),
    );
    expect(fileButton).toBeDefined();
    fireEvent.click(fileButton as HTMLElement);

    expect(props.onSelect).toHaveBeenCalledWith('src/AppShell.tsx');
    expect(props.onClose).toHaveBeenCalled();
  });

  it('关闭对话框（open=false）不渲染内容', () => {
    renderDialog({ open: false });
    expect(screen.queryByText('输入关键词搜索文件或会话')).not.toBeInTheDocument();
  });

  it('点击会话结果 → 切换激活会话 + onClose', async () => {
    const props = renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '登录' } });

    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain('修复登录页');
    });
    // 会话结果按钮（mark 拆分文本节点，getByText 不可用）
    const sessionButton = [...document.querySelectorAll('#fuzzy-search-results button')].find((b) =>
      b.textContent?.includes('登录'),
    );
    expect(sessionButton).toBeDefined();
    fireEvent.click(sessionButton as HTMLElement);

    expect(useActiveSessionStore.getState().activeSessionId).toBe('s2');
    expect(props.onClose).toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('键盘 ArrowUp：已在首项时不越界（仍选中第一个）', async () => {
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    const props = renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'App' } });

    await waitFor(() => {
      expect(document.querySelector('#fuzzy-search-results')?.textContent).toContain('App.tsx');
    });
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(props.onSelect).toHaveBeenCalledWith('src/App.tsx');
  });

  it('文件搜索异常：提示失败且不崩溃', async () => {
    useActiveSessionStore.setState({ activeSessionId: 's1' });
    window.api.search = {
      glob: vi.fn().mockRejectedValue(new Error('ipc down')),
      grep: vi.fn(),
    } as never;
    renderDialog();
    await flushOpenReset();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'App' } });

    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
  });
});
