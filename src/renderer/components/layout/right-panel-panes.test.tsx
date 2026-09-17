// src/renderer/components/layout/right-panel-panes.test.tsx
// 右面板 pane 测试（正向 / 边界 / 异常）：
// - InfoPane：task 状态视觉 / 引用文件去重（tool-store read_file）
// - DiffPane：变更过滤派生（仅 edit_file/write_file 且 success/error）/ 展开
//   拉取 diff（useGitDiffQuery enabled）/ 打开文件 / 会话切换清空展开态
// ──────────────────────────────────────────────────────────────
// mock 边界：use-git（diff 数据边界，沿用 GitPanel.test 做法）+ window.api.task；
// tool-store / file-viewer-store / UnifiedDiffView 走真实实现。
// ──────────────────────────────────────────────────────────────

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';
import { ThemeProvider } from '@/providers/ThemeProvider';
import { useFileViewerStore } from '@/stores/transient/file-viewer-store';
import { useToolStore } from '@/stores/transient/tool-store';

const { mockUseGitDiffQuery } = vi.hoisted(() => ({ mockUseGitDiffQuery: vi.fn() }));

vi.mock('@/hooks/use-git', () => ({
  useGitDiffQuery: mockUseGitDiffQuery,
}));

import { DiffPane, InfoPane } from './right-panel-panes';

const t = i18n.t.bind(i18n);

function renderWithQuery(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 展开的 diff 经 UnifiedDiffView 消费 useTheme → 需要 ThemeProvider
  return render(
    <QueryClientProvider client={client}>
      <ThemeProvider>{ui}</ThemeProvider>
    </QueryClientProvider>,
  );
}

/** tool-store 调用条目工厂（与 ToolCallEntry 投影对齐） */
function call(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides['id'] ?? 'c1',
    toolName: overrides['toolName'] ?? 'write_file',
    status: overrides['status'] ?? 'success',
    input: overrides['input'] ?? { path: '/proj/a.ts' },
    title: overrides['title'] ?? '写入文件',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseGitDiffQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  });
  useToolStore.setState({ callsBySession: new Map() });
});

describe('InfoPane', () => {
  it('正向：task 按状态渲染（completed 删除线 / running spinner）', async () => {
    window.api = {
      task: {
        list: vi.fn().mockResolvedValue({
          data: {
            tasks: [
              { id: 't1', description: '已完成项', status: 'completed' },
              { id: 't2', description: '进行中项', status: 'running' },
              { id: 't3', description: '失败项', status: 'failed' },
            ],
          },
        }),
      },
    } as never;
    renderWithQuery(<InfoPane sessionId="s1" />);

    expect(await screen.findByText('已完成项')).toBeDefined();
    expect(screen.getByText('进行中项')).toBeDefined();
    expect(screen.getByText('失败项')).toBeDefined();
  });

  it('正向：引用文件从 read_file 调用去重提取（同路径保留最新位置）', () => {
    useToolStore.setState({
      callsBySession: new Map([
        [
          's1',
          [
            call({ id: 'r1', toolName: 'read_file', input: { path: '/proj/a.ts' } }),
            call({ id: 'r2', toolName: 'read_file', input: { path: '/proj/b.ts' } }),
            call({ id: 'r3', toolName: 'read_file', input: { path: '/proj/a.ts' } }),
          ],
        ],
      ]),
    } as never);
    renderWithQuery(<InfoPane sessionId="s1" />);

    // 倒序后 a.ts（r3 最新）先于 b.ts，a.ts 去重只出现一次
    const files = screen.getAllByText(/\/proj\/[ab]\.ts/);
    expect(files).toHaveLength(2);
    expect(files[0]?.textContent).toContain('/proj/a.ts');
    expect(files[1]?.textContent).toContain('/proj/b.ts');
  });

  it('边界：无 task / 无调用 → 渲染空态不崩溃', () => {
    window.api = { task: { list: vi.fn().mockResolvedValue({ data: { tasks: [] } }) } } as never;
    renderWithQuery(<InfoPane sessionId="s1" />);
    expect(screen.getByText(t('panel.tasks'))).toBeDefined();
  });
});

describe('DiffPane', () => {
  function seedCalls(): void {
    useToolStore.setState({
      callsBySession: new Map([
        [
          's1',
          [
            call({
              id: 'c1',
              toolName: 'edit_file',
              status: 'success',
              input: { path: '/proj/a.ts' },
            }),
            call({
              id: 'c2',
              toolName: 'write_file',
              status: 'error',
              input: { path: '/proj/b.ts' },
            }),
            call({
              id: 'c3',
              toolName: 'read_file',
              status: 'success',
              input: { path: '/proj/c.ts' },
            }),
            call({
              id: 'c4',
              toolName: 'edit_file',
              status: 'pending',
              input: { path: '/proj/d.ts' },
            }),
          ],
        ],
      ]),
    } as never);
  }

  it('边界：无变更 → 渲染空态文案', () => {
    renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);
    expect(screen.getByText(t('panel.noChanges'))).toBeDefined();
  });

  it('正向：仅展示 edit_file/write_file 且 success/error 的记录（倒序，read_file 与 pending 过滤）', () => {
    seedCalls();
    renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);

    // 倒序：最新在前；pending 的 d.ts 与 read_file 的 c.ts 不出现
    const rows = screen.getAllByText(/^[ab]\.ts$/);
    expect(rows).toHaveLength(2);
    expect(screen.queryByText('d.ts')).toBeNull();
    expect(screen.queryByText('c.ts')).toBeNull();
    // 徽标语义：write_file → NEW，edit_file → EDIT
    expect(screen.getByText('EDIT')).toBeDefined();
    expect(screen.getByText('NEW')).toBeDefined();
  });

  it('正向：展开变更 → useGitDiffQuery 启用并渲染 diff 内容', async () => {
    // 带 hunk 头的合法 unified diff（parseUnifiedDiff 需要 @@ 头才产出块）
    mockUseGitDiffQuery.mockReturnValue({
      data: { diff: '@@ -1,1 +1,2 @@\n line1\n+line2' },
      isLoading: false,
      isError: false,
    });
    seedCalls();
    renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);

    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);

    await waitFor(() =>
      expect(mockUseGitDiffQuery).toHaveBeenCalledWith(
        expect.objectContaining({ filePath: '/proj/b.ts', ref: 'HEAD', staged: false }),
        true,
      ),
    );
    // diff 内容经 react-diff-viewer 逐行渲染（文本会被拆分），断言表结构落地
    expect(document.querySelector('table')).not.toBeNull();
  });

  it('异常边界：diff 查询失败 → 显示不可用文案而非崩溃', () => {
    mockUseGitDiffQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    seedCalls();
    renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);

    expect(screen.getByText(t('panel.diffUnavailable'))).toBeDefined();
  });

  it('异常边界：diff 加载中 → 显示加载文案', () => {
    mockUseGitDiffQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    seedCalls();
    renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);

    expect(screen.getByText(t('panel.diffLoading'))).toBeDefined();
  });

  it('正向：gitRepoPath 缺省 → 查询不启用（仅展示变更列表）', () => {
    seedCalls();
    renderWithQuery(<DiffPane sessionId="s1" />);
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);

    expect(mockUseGitDiffQuery).toHaveBeenCalledWith(expect.anything(), false);
  });

  it('正向：点击打开文件按钮 → file-viewer-store.openFile(路径)', () => {
    seedCalls();
    const openFileSpy = vi.spyOn(useFileViewerStore.getState(), 'openFile');
    renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);

    fireEvent.click(screen.getAllByLabelText(t('panel.openFile'))[0] as HTMLElement);
    expect(openFileSpy).toHaveBeenCalledWith('/proj/b.ts');
    openFileSpy.mockRestore();
  });

  it('正向边界：会话切换 → 展开态清空（重挂载语义由 key/effect 承载）', () => {
    seedCalls();
    const { rerender } = renderWithQuery(<DiffPane sessionId="s1" gitRepoPath="/proj" />);
    fireEvent.click(screen.getAllByRole('button', { expanded: false })[0] as HTMLElement);
    expect(document.querySelector('[aria-expanded="true"]')).not.toBeNull();

    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <DiffPane sessionId="s2" gitRepoPath="/proj" />
      </QueryClientProvider>,
    );
    // s2 无任何变更 → 直接落空态（展开态随重置清空的可见结果）
    expect(screen.getByText(t('panel.noChanges'))).toBeDefined();
  });
});
