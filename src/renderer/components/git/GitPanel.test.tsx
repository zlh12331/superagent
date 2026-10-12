import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';

const { mockUseGitStatusQuery, mockUseGitDiffQuery, mockRefetch } = vi.hoisted(() => ({
  mockUseGitStatusQuery: vi.fn(),
  mockUseGitDiffQuery: vi.fn(),
  mockRefetch: vi.fn(),
}));

vi.mock('@/hooks/use-git', () => ({
  useGitStatusQuery: mockUseGitStatusQuery,
  useGitDiffQuery: mockUseGitDiffQuery,
}));

import { GitPanel } from './GitPanel';

const cleanStatus = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  clean: true,
  files: [],
};

const dirtyStatus = {
  branch: 'feature/test',
  ahead: 2,
  behind: 1,
  clean: false,
  files: [
    { path: 'src/a.ts', status: 'modified' as const },
    { path: 'src/b.ts', status: 'added' as const },
    { path: 'src/c.ts', status: 'deleted' as const },
    { path: 'src/d.ts', status: 'untracked' as const },
    { path: 'src/e.ts', status: 'conflicted' as const },
    { path: 'src/f.ts', status: 'renamed' as const },
  ],
};

const sampleDiff = {
  diff: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,3 @@\n-old line\n+new line',
  additions: 1,
  deletions: 1,
};

function setStatusState(
  overrides?: Partial<{
    data: typeof cleanStatus | typeof dirtyStatus | undefined;
    isLoading: boolean;
    error: Error | null;
    refetch: ReturnType<typeof vi.fn>;
    isFetching: boolean;
  }>,
): void {
  mockUseGitStatusQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: mockRefetch,
    isFetching: false,
    ...overrides,
  });
}

function setDiffState(
  overrides?: Partial<{
    data: typeof sampleDiff | undefined;
    isLoading: boolean;
  }>,
): void {
  mockUseGitDiffQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    ...overrides,
  });
}

describe('GitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setStatusState();
    setDiffState();
  });

  describe('加载中状态', () => {
    it('isLoading=true → 渲染骨架屏（4 个 Skeleton）', () => {
      setStatusState({ isLoading: true });

      const { container } = render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      const skeletons = container.querySelectorAll('[data-slot="skeleton"]');
      expect(skeletons.length).toBeGreaterThanOrEqual(4);
    });

    it('分支信息：isLoading 时显示「加载中...」', () => {
      setStatusState({ isLoading: true });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('加载中...')).toBeInTheDocument();
    });
  });

  describe('错误状态', () => {
    it('error 非 null → 显示 ErrorHint + 错误消息', () => {
      setStatusState({ error: new Error('Not a git repository') });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('Git 状态获取失败')).toBeInTheDocument();
      expect(screen.getByText('Not a git repository')).toBeInTheDocument();
    });

    it('error + status 同时为空 → 显示 ErrorHint（"Git 状态为空"）', () => {
      setStatusState({ data: undefined, error: null });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('Git 状态获取失败')).toBeInTheDocument();
      expect(screen.getByText('Git 状态为空')).toBeInTheDocument();
    });

    it('分支信息：error 时显示「无法获取」', () => {
      setStatusState({ error: new Error('fail') });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('无法获取')).toBeInTheDocument();
    });
  });

  describe('工作区干净', () => {
    it('clean=true → 显示「工作区干净」+「无变更文件」', () => {
      setStatusState({ data: cleanStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('工作区干净')).toBeInTheDocument();
      expect(screen.getByText('无变更文件')).toBeInTheDocument();
    });

    it('分支信息：clean 时显示分支名 main', () => {
      setStatusState({ data: cleanStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('main')).toBeInTheDocument();
    });
  });

  describe('有变更文件', () => {
    it('渲染所有文件项（图标 + 路径 + 状态标签）', () => {
      setStatusState({ data: dirtyStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      for (const file of dirtyStatus.files) {
        expect(screen.getByText(file.path)).toBeInTheDocument();
      }
      expect(screen.getByText('修改')).toBeInTheDocument();
      expect(screen.getByText('新增')).toBeInTheDocument();
      expect(screen.getByText('删除')).toBeInTheDocument();
      expect(screen.getByText('未跟踪')).toBeInTheDocument();
      expect(screen.getByText('冲突')).toBeInTheDocument();
      expect(screen.getByText('重命名')).toBeInTheDocument();
    });

    it('分支信息：显示 ahead/behind 标记', () => {
      setStatusState({ data: dirtyStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.getByText('↑2')).toBeInTheDocument();
      expect(screen.getByText('↓1')).toBeInTheDocument();
      expect(screen.getByText('feature/test')).toBeInTheDocument();
    });

    it('点击文件 → 触发 useGitDiffQuery（selectedFilePath 不为 null）', async () => {
      setStatusState({ data: dirtyStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      fireEvent.click(screen.getByText('src/a.ts'));

      await waitFor(() => {
        expect(mockUseGitDiffQuery).toHaveBeenCalledWith(
          expect.objectContaining({
            path: '/repo',
            ref: 'HEAD',
            staged: false,
            filePath: 'src/a.ts',
          }),
          true,
        );
      });
    });

    it('点击文件 → 显示 diff 视图（FileDiffView）', async () => {
      setStatusState({ data: dirtyStatus });
      setDiffState({ data: sampleDiff });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      expect(screen.queryByText('+1')).not.toBeInTheDocument();

      fireEvent.click(screen.getByText('src/a.ts'));

      await waitFor(() => {
        expect(screen.getByText('+1')).toBeInTheDocument();
        expect(screen.getByText('-1')).toBeInTheDocument();
      });
    });

    it('点击已选中文件 → 仍保持选中态', () => {
      setStatusState({ data: dirtyStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      const fileBtn = screen.getByText('src/a.ts').closest('button');
      expect(fileBtn).not.toBeNull();

      fireEvent.click(screen.getByText('src/a.ts'));
      fireEvent.click(screen.getByText('src/a.ts'));

      expect(fileBtn?.className).toContain('bg-accent');
    });
  });

  describe('刷新按钮', () => {
    it('点击刷新 → 调用 refetch', () => {
      setStatusState({ data: cleanStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      const refreshBtn = screen.getByRole('button', { name: '刷新 Git 状态' });
      fireEvent.click(refreshBtn);

      expect(mockRefetch).toHaveBeenCalledTimes(1);
    });

    it('isFetching=true → 刷新按钮 disabled', () => {
      setStatusState({ data: cleanStatus, isFetching: true });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      const refreshBtn = screen.getByRole('button', { name: '刷新 Git 状态' });
      expect(refreshBtn).toBeDisabled();
    });
  });

  describe('diff 视图', () => {
    it('点击折叠按钮 → 折叠 diff 内容', async () => {
      setStatusState({ data: dirtyStatus });
      setDiffState({ data: sampleDiff });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      fireEvent.click(screen.getByText('src/a.ts'));
      await waitFor(() => {
        expect(screen.getByText('+1')).toBeInTheDocument();
      });

      const toggleBtn = screen.getByRole('button', { expanded: true });
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

      fireEvent.click(toggleBtn);
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

      expect(screen.queryByText('@@ -1,3 +1,3 @@')).not.toBeInTheDocument();
    });

    it('diff 为空字符串 → 显示「无 diff 内容」', async () => {
      setStatusState({ data: dirtyStatus });
      setDiffState({ data: { diff: '', additions: 0, deletions: 0 } });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      fireEvent.click(screen.getByText('src/a.ts'));

      await waitFor(() => {
        expect(screen.getByText('无 diff 内容')).toBeInTheDocument();
      });
    });

    it('diff isLoading → 显示骨架屏', async () => {
      setStatusState({ data: dirtyStatus });
      setDiffState({ isLoading: true });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      fireEvent.click(screen.getByText('src/a.ts'));

      await waitFor(() => {
        expect(screen.queryByText('无 diff 内容')).not.toBeInTheDocument();
      });
    });
  });

  describe('自定义 className', () => {
    it('传入 className → 容器合并 class', () => {
      setStatusState({ data: cleanStatus });

      const { container } = render(
        <ThemeProvider>
          <GitPanel path="/repo" className="custom-class" />
        </ThemeProvider>,
      );

      const root = container.firstElementChild;
      expect(root?.className).toContain('custom-class');
    });
  });
});
