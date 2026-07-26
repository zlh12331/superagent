// src/renderer/components/layout/__tests__/DevPanel.test.tsx
// DevPanel 组件测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 默认折叠（expanded=false）→ 仅标题栏，内容区不渲染
// 2. 点击展开按钮 → 展开 + 渲染 TerminalPanel
// 3. 再次点击展开按钮 → 折叠 + 不渲染内容区
// 4. 切换到 Git Tab → 渲染 GitPanel（替代 TerminalPanel）
// 5. 切换 Tab 时自动展开（折叠态切 Tab → 展开）
// 6. aria-expanded 属性
// 7. 自定义 className
// 8. Logs / Metrics / Inspector Tab 切换 + enabled 透传
//
// 策略：
// - mock TerminalPanel / GitPanel / LogsPanel / MetricsPanel / InspectorPanel 子组件
// - 仅断言是否被渲染 + props 透传
// - 避免依赖 xterm/TanStack Query / IPC 等外部依赖
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── mock 子组件（避免依赖 xterm / TanStack Query） ───────────
//
// vi.hoisted 提升 mock 函数，使 vi.mock factory 可安全引用
const { mockTerminalPanel, mockGitPanel, mockLogsPanel, mockMetricsPanel, mockInspectorPanel } =
  vi.hoisted(() => ({
    mockTerminalPanel: vi.fn(),
    mockGitPanel: vi.fn(),
    mockLogsPanel: vi.fn(),
    mockMetricsPanel: vi.fn(),
    mockInspectorPanel: vi.fn(),
  }));

vi.mock('@/components/terminal/TerminalPanel', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  TerminalPanel: mockTerminalPanel,
}));

vi.mock('@/components/git/GitPanel', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  GitPanel: mockGitPanel,
}));

vi.mock('@/components/dev/LogsPanel', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  LogsPanel: mockLogsPanel,
}));

vi.mock('@/components/dev/MetricsPanel', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  MetricsPanel: mockMetricsPanel,
}));

vi.mock('@/components/dev/InspectorPanel', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  InspectorPanel: mockInspectorPanel,
}));

import { DevPanel } from '../DevPanel';

// ── mock 组件实现（返回固定占位） ────────────────────────────
//
// 每次调用 mock*Panel 都返回一个带 data-testid 的 div
// 便于用 screen.queryByTestId 检测是否被渲染
function MockTerminalPanel(props: { sessionId: string; className?: string }): ReactElement {
  return (
    <div
      data-testid="terminal-panel"
      data-session-id={props.sessionId}
      data-class={props.className}
    />
  );
}

function MockGitPanel(props: { path: string; className?: string }): ReactElement {
  return <div data-testid="git-panel" data-path={props.path} data-class={props.className} />;
}

function MockLogsPanel(props: { enabled?: boolean; className?: string }): ReactElement {
  return (
    <div
      data-testid="logs-panel"
      data-enabled={props.enabled === undefined ? 'undefined' : String(props.enabled)}
      data-class={props.className}
    />
  );
}

function MockMetricsPanel(props: { enabled?: boolean; className?: string }): ReactElement {
  return (
    <div
      data-testid="metrics-panel"
      data-enabled={props.enabled === undefined ? 'undefined' : String(props.enabled)}
      data-class={props.className}
    />
  );
}

function MockInspectorPanel(props: { className?: string }): ReactElement {
  return <div data-testid="inspector-panel" data-class={props.className} />;
}

describe('DevPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置 mock 实现（每个测试前确保返回占位组件）
    mockTerminalPanel.mockImplementation(MockTerminalPanel);
    mockGitPanel.mockImplementation(MockGitPanel);
    mockLogsPanel.mockImplementation(MockLogsPanel);
    mockMetricsPanel.mockImplementation(MockMetricsPanel);
    mockInspectorPanel.mockImplementation(MockInspectorPanel);
  });

  // ── 默认折叠 ──────────────────────────────────────────
  describe('默认折叠', () => {
    it('初始渲染：折叠态 → 仅标题栏，不渲染内容区', () => {
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 展开按钮存在（aria-expanded=false）
      const expandBtn = screen.getByRole('button', { name: '展开开发面板' });
      expect(expandBtn).toHaveAttribute('aria-expanded', 'false');

      // 内容区不渲染（所有面板都不应被渲染）
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('logs-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('metrics-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('inspector-panel')).not.toBeInTheDocument();
    });

    it('折叠态渲染「终端」「Git」「日志」「指标」「检查器」五个 Tab', () => {
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      expect(screen.getByText('终端')).toBeInTheDocument();
      expect(screen.getByText('Git')).toBeInTheDocument();
      expect(screen.getByText('日志')).toBeInTheDocument();
      expect(screen.getByText('指标')).toBeInTheDocument();
      expect(screen.getByText('检查器')).toBeInTheDocument();
    });

    it('默认 activeTab=terminal', () => {
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 终端 Tab 应有 active 状态（Radix TabsTrigger 选中时 data-state=active）
      const terminalTab = screen.getByText('终端').closest('[role="tab"]');
      expect(terminalTab).toHaveAttribute('data-state', 'active');
    });
  });

  // ── 折叠/展开 ─────────────────────────────────────────
  describe('折叠/展开', () => {
    it('点击展开按钮 → 展开 + 渲染 TerminalPanel（默认 activeTab=terminal）', () => {
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      const expandBtn = screen.getByRole('button', { name: '展开开发面板' });
      fireEvent.click(expandBtn);

      // aria-expanded 变为 true
      expect(expandBtn).toHaveAttribute('aria-expanded', 'true');
      // 按钮的 aria-label 切换为「收起开发面板」
      expect(expandBtn).toHaveAttribute('aria-label', '收起开发面板');

      // 内容区渲染 → TerminalPanel 被调用
      expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();
      // sessionId 透传
      expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-session-id', 's1');
    });

    it('再次点击展开按钮 → 折叠 + 不渲染内容区', () => {
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      const expandBtn = screen.getByRole('button', { name: '展开开发面板' });

      // 展开
      fireEvent.click(expandBtn);
      expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();

      // 再次点击 → 折叠
      fireEvent.click(expandBtn);
      expect(expandBtn).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();
    });

    it('展开 → 折叠 → 展开：状态保持默认 activeTab', () => {
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      const expandBtn = screen.getByRole('button', { name: '展开开发面板' });

      // 展开
      fireEvent.click(expandBtn);
      expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();

      // 折叠
      fireEvent.click(expandBtn);
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();

      // 再次展开 → 仍是 terminal Tab（activeTab 状态保留）
      fireEvent.click(expandBtn);
      expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();
    });
  });

  // ── Tab 切换 ──────────────────────────────────────────
  describe('Tab 切换', () => {
    it('点击 Git Tab → 切换到 GitPanel + 自动展开', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 初始折叠，无内容
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();

      // 点击 Git Tab（Radix Tabs 需要 pointerDown 触发，用 userEvent 模拟真实交互）
      await user.click(screen.getByText('Git'));

      // 自动展开 + 渲染 GitPanel
      expect(screen.getByTestId('git-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();

      // gitRepoPath 透传
      expect(screen.getByTestId('git-panel')).toHaveAttribute('data-path', '/repo');
    });

    it('展开态下切换 Tab → 切换内容区（TerminalPanel ↔ GitPanel）', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 先展开（默认 terminal）
      fireEvent.click(screen.getByRole('button', { name: '展开开发面板' }));
      expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();

      // 切换到 Git
      await user.click(screen.getByText('Git'));
      expect(screen.getByTestId('git-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();

      // 切回终端
      await user.click(screen.getByText('终端'));
      expect(screen.getByTestId('terminal-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
    });

    it('切换 Tab 后折叠 → 重新展开保持切换后的 Tab', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 切换到 Git Tab（自动展开）
      await user.click(screen.getByText('Git'));
      expect(screen.getByTestId('git-panel')).toBeInTheDocument();

      // 折叠
      fireEvent.click(screen.getByRole('button', { name: '收起开发面板' }));
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();

      // 重新展开 → 仍是 Git Tab
      fireEvent.click(screen.getByRole('button', { name: '展开开发面板' }));
      expect(screen.getByTestId('git-panel')).toBeInTheDocument();
    });

    it('sessionId 变化 → TerminalPanel 接收新的 sessionId', () => {
      const { rerender } = render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 展开
      fireEvent.click(screen.getByRole('button', { name: '展开开发面板' }));
      expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-session-id', 's1');

      // 切换 sessionId
      rerender(<DevPanel sessionId="s2" gitRepoPath="/repo" />);
      expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-session-id', 's2');
    });

    it('gitRepoPath 变化 → GitPanel 接收新的 path', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<DevPanel sessionId="s1" gitRepoPath="/repo1" />);

      // 切换到 Git Tab
      await user.click(screen.getByText('Git'));
      expect(screen.getByTestId('git-panel')).toHaveAttribute('data-path', '/repo1');

      // 切换 gitRepoPath
      rerender(<DevPanel sessionId="s1" gitRepoPath="/repo2" />);
      expect(screen.getByTestId('git-panel')).toHaveAttribute('data-path', '/repo2');
    });

    // ── Logs / Metrics Tab（新增） ─────────────────────
    it('点击日志 Tab → 切换到 LogsPanel + 自动展开 + enabled=true', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 点击日志 Tab
      await user.click(screen.getByText('日志'));

      // 自动展开 + 渲染 LogsPanel
      expect(screen.getByTestId('logs-panel')).toBeInTheDocument();
      // 其他面板不渲染
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('metrics-panel')).not.toBeInTheDocument();

      // enabled 透传（展开态应为 true）
      expect(screen.getByTestId('logs-panel')).toHaveAttribute('data-enabled', 'true');
    });

    it('点击指标 Tab → 切换到 MetricsPanel + 自动展开 + enabled=true', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      await user.click(screen.getByText('指标'));

      expect(screen.getByTestId('metrics-panel')).toBeInTheDocument();
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('logs-panel')).not.toBeInTheDocument();

      expect(screen.getByTestId('metrics-panel')).toHaveAttribute('data-enabled', 'true');
    });

    it('折叠态下 Logs/Metrics 面板不渲染（enabled 不影响渲染逻辑，仅控制查询）', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 切换到日志 Tab（自动展开）
      await user.click(screen.getByText('日志'));
      expect(screen.getByTestId('logs-panel')).toBeInTheDocument();
      expect(screen.getByTestId('logs-panel')).toHaveAttribute('data-enabled', 'true');

      // 折叠 → 内容区不渲染
      fireEvent.click(screen.getByRole('button', { name: '收起开发面板' }));
      expect(screen.queryByTestId('logs-panel')).not.toBeInTheDocument();
    });

    // ── Inspector Tab（新增） ──────────────────────────
    it('点击检查器 Tab → 切换到 InspectorPanel + 自动展开', async () => {
      const user = userEvent.setup();
      render(<DevPanel sessionId="s1" gitRepoPath="/repo" />);

      // 点击检查器 Tab
      await user.click(screen.getByText('检查器'));

      // 自动展开 + 渲染 InspectorPanel
      expect(screen.getByTestId('inspector-panel')).toBeInTheDocument();
      // 其他面板不渲染
      expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('logs-panel')).not.toBeInTheDocument();
      expect(screen.queryByTestId('metrics-panel')).not.toBeInTheDocument();

      // className 透传
      expect(screen.getByTestId('inspector-panel')).toHaveAttribute('data-class', 'h-full');
    });
  });

  // ── 自定义 className ─────────────────────────────────
  describe('自定义 className', () => {
    it('传入 className → 根容器合并 class', () => {
      const { container } = render(
        <DevPanel sessionId="s1" gitRepoPath="/repo" className="custom-class" />,
      );

      const root = container.firstElementChild;
      expect(root?.className).toContain('custom-class');
    });
  });
});
