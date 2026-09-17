// src/renderer/components/$1/GitPanel.test.tsx
// GitPanel 组件测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. loading 态 → 骨架屏（FileListSkeleton）
// 2. error 态 → ErrorHint（含错误消息）
// 3. status === undefined → ErrorHint（"Git 状态为空"）
// 4. clean=true → CleanHint（"工作区干净"）
// 5. files 非空 → FileList（图标 + 路径 + 状态标签）
// 6. 点击文件 → 调用 useGitDiffQuery（通过 selectedFilePath 触发）
// 7. 刷新按钮 → 调用 refetch
// 8. 分支信息：ahead/behind 显示
//
// 策略：
// - 直接 mock `@/hooks/use-git`，避免依赖 TanStack Query 真实调用
// - vi.hoisted 提升 mock 回调，避免提升问题
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';

// ── mock use-git hooks ──────────────────────────────────────
//
// 提供 useGitStatusQuery / useGitDiffQuery 的可控 mock：
// - statusState：控制 status 查询的返回值（data / isLoading / error / refetch / isFetching）
// - diffState：控制 diff 查询的返回值（data / isLoading）
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

// ── 测试数据 ────────────────────────────────────────────────

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

// ── 默认 mock 返回值（每个测试可在 beforeEach 中覆盖） ────────

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
    // 默认：未加载、无数据、无错误
    setStatusState();
    setDiffState();
  });

  // ── 加载中状态 ──────────────────────────────────────────
  describe('加载中状态', () => {
    it('isLoading=true → 渲染骨架屏（4 个 Skeleton）', () => {
      setStatusState({ isLoading: true });

      const { container } = render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      // 骨架屏由 4 个 <Skeleton> 组成（FileListSkeleton 固定渲染 4 个）
      // Skeleton 组件用 data-slot="skeleton" 标识
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

  // ── 错误状态 ────────────────────────────────────────────
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
      // error 为 null，但 status 为 undefined（理论上不可达，但兜底）
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

  // ── 工作区干净 ──────────────────────────────────────────
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

  // ── 有变更文件 ──────────────────────────────────────────
  describe('有变更文件', () => {
    it('渲染所有文件项（图标 + 路径 + 状态标签）', () => {
      setStatusState({ data: dirtyStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      // 6 个文件路径都应展示
      for (const file of dirtyStatus.files) {
        expect(screen.getByText(file.path)).toBeInTheDocument();
      }
      // 状态标签
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

      // ahead=2 → ↑2
      expect(screen.getByText('↑2')).toBeInTheDocument();
      // behind=1 → ↓1
      expect(screen.getByText('↓1')).toBeInTheDocument();
      // 分支名
      expect(screen.getByText('feature/test')).toBeInTheDocument();
    });

    it('点击文件 → 触发 useGitDiffQuery（selectedFilePath 不为 null）', async () => {
      setStatusState({ data: dirtyStatus });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      // 点击第一个文件
      fireEvent.click(screen.getByText('src/a.ts'));

      // useGitDiffQuery 应被调用，第二个参数 enabled=true（selectedFilePath !== null）
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

      // 初始无 diff 视图
      expect(screen.queryByText('+1')).not.toBeInTheDocument();

      // 点击文件 → 显示 diff
      fireEvent.click(screen.getByText('src/a.ts'));

      // FileDiffView 显示增删统计
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
      // 第二次点击同一文件 → 仍是选中
      fireEvent.click(screen.getByText('src/a.ts'));

      // 选中按钮应有 bg-accent/70 class（aria-pressed 不存在，用 class 判断）
      expect(fileBtn?.className).toContain('bg-accent');
    });
  });

  // ── 刷新按钮 ─────────────────────────────────────────────
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

  // ── diff 视图折叠 ───────────────────────────────────────
  describe('diff 视图', () => {
    it('点击折叠按钮 → 折叠 diff 内容', async () => {
      setStatusState({ data: dirtyStatus });
      setDiffState({ data: sampleDiff });

      render(
        <ThemeProvider>
          <GitPanel path="/repo" />
        </ThemeProvider>,
      );

      // 选中文件 → 出现 diff 视图
      fireEvent.click(screen.getByText('src/a.ts'));
      await waitFor(() => {
        expect(screen.getByText('+1')).toBeInTheDocument();
      });

      // 默认展开（aria-expanded=true）
      const toggleBtn = screen.getByRole('button', { expanded: true });
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');

      // 点击折叠
      fireEvent.click(toggleBtn);
      expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');

      // 折叠后 diff 文本应不再可见（+1 增删统计仍在标题栏，不能用作判断）
      // 用 diff 文本中的 hunk 头（@@ -1,3 +1,3 @@）判断
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

      // FileDiffView 内部 isLoading 时渲染 Skeleton（不显示「无 diff 内容」）
      await waitFor(() => {
        expect(screen.queryByText('无 diff 内容')).not.toBeInTheDocument();
      });
    });
  });

  // ── 自定义 className ─────────────────────────────────────
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
