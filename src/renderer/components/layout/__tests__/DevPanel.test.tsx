// src/renderer/components/layout/__tests__/DevPanel.test.tsx
// DevPanel 组件测试（右面板 · 会话上下文面板）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 默认展开 + 默认 activeTab=info（会话详情）
// 2. 点击折叠按钮 → 折叠 + 不渲染内容区；再点展开
// 3. 切换到 diff / terminal Tab → 渲染对应 pane
// 4. 切换到 dev Tab → 默认 git 子视图；切换 logs/metrics/inspector
// 5. sessionId / gitRepoPath props 透传
// 6. 自定义 className
//
// 策略：
// - mock 子组件（InfoPane/DiffPane/TerminalPanel/GitPanel/LogsPanel/MetricsPanel/InspectorPanel）
// - 仅断言是否被渲染 + props 透传
// - 避免依赖 xterm/TanStack Query/IPC 等外部依赖
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore } from '@/stores/transient/ui-store';

// ── mock 子组件 ─────────────────────────────────────────────
const {
  mockInfoPane,
  mockDiffPane,
  mockFileViewerPanel,
  mockTerminalPanel,
  mockGitPanel,
  mockLogsPanel,
  mockMetricsPanel,
  mockInspectorPanel,
} = vi.hoisted(() => ({
  mockInfoPane: vi.fn(),
  mockDiffPane: vi.fn(),
  mockFileViewerPanel: vi.fn(),
  mockTerminalPanel: vi.fn(),
  mockGitPanel: vi.fn(),
  mockLogsPanel: vi.fn(),
  mockMetricsPanel: vi.fn(),
  mockInspectorPanel: vi.fn(),
}));

vi.mock('../right-panel-panes', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  InfoPane: mockInfoPane,
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  DiffPane: mockDiffPane,
}));

vi.mock('@/components/file-tree/FileViewerPanel', () => ({
  // biome-ignore lint/style/useNamingConvention: 保持与模块导出名一致
  FileViewerPanel: mockFileViewerPanel,
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

// ── mock 组件实现 ───────────────────────────────────────────
function MockInfoPane(props: { sessionId: string }): ReactElement {
  return <div data-testid="info-pane" data-session-id={props.sessionId} />;
}

function MockDiffPane(props: { sessionId: string }): ReactElement {
  return <div data-testid="diff-pane" data-session-id={props.sessionId} />;
}

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

/** 渲染 DevPanel 的公共 helper */
function renderDevPanel(props: Partial<React.ComponentProps<typeof DevPanel>> = {}) {
  return render(<DevPanel sessionId="session-1" gitRepoPath="/repo" {...props} />);
}

describe('DevPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 重置右面板激活 tab（动态 tab 依赖 activeTab——避免跨用例残留导致视图自动加入）
    useUiStore.getState().setDevPanelTab('info');
    mockInfoPane.mockImplementation(MockInfoPane);
    mockDiffPane.mockImplementation(MockDiffPane);
    mockFileViewerPanel.mockImplementation(() => <div data-testid="file-viewer-panel" />);
    mockTerminalPanel.mockImplementation(MockTerminalPanel);
    mockGitPanel.mockImplementation(MockGitPanel);
    mockLogsPanel.mockImplementation(MockLogsPanel);
    mockMetricsPanel.mockImplementation(MockMetricsPanel);
    mockInspectorPanel.mockImplementation(MockInspectorPanel);
  });

  // ── 默认状态 ─────────────────────────────────────────────
  it('默认展开且默认 activeTab=info（渲染会话详情 pane）', () => {
    renderDevPanel();
    expect(screen.getByTestId('info-pane')).toBeInTheDocument();
    expect(mockInfoPane).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'session-1' }),
      undefined,
    );
  });

  it('移除面板内折叠按钮（对齐原型：折叠由全局机制管理）', async () => {
    renderDevPanel();
    // 不再有面板内折叠按钮（仅全局顶栏按钮管理折叠）
    expect(screen.queryByRole('button', { name: /收起|展开/ })).toBeNull();
    // 内容始终渲染
    expect(screen.getByTestId('info-pane')).toBeInTheDocument();
  });

  // ── Tab 切换（动态 tab：默认仅任务摘要，其余通过"+"添加）──────
  it('切换 diff / terminal Tab 渲染对应 pane（先添加视图）', async () => {
    renderDevPanel();
    // 通过"+"添加文件变更 / 终端视图
    await userEvent.click(screen.getByRole('button', { name: '添加视图' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '文件变更' }));
    await userEvent.click(screen.getByRole('button', { name: '添加视图' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '终端' }));

    await userEvent.click(screen.getByRole('tab', { name: /文件变更/ }));
    expect(screen.getByTestId('diff-pane')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: /终端/ }));
    // lazy 加载（xterm chunk）：异步渲染，需等待 Suspense 完成
    expect(await screen.findByTestId('terminal-panel')).toBeInTheDocument();
  });

  // ── 开发者子视图 ─────────────────────────────────────────
  it('dev Tab 默认 git 子视图，可切换 logs/metrics/inspector', async () => {
    renderDevPanel();
    // 通过"+"添加开发者视图
    await userEvent.click(screen.getByRole('button', { name: '添加视图' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '开发者' }));
    await userEvent.click(screen.getByRole('tab', { name: /开发者/ }));
    expect(screen.getByTestId('git-panel')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /日志/ }));
    expect(screen.getByTestId('logs-panel')).toBeInTheDocument();
    expect(mockLogsPanel).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
      undefined,
    );

    await userEvent.click(screen.getByRole('button', { name: /指标/ }));
    expect(screen.getByTestId('metrics-panel')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /检查器/ }));
    expect(screen.getByTestId('inspector-panel')).toBeInTheDocument();
  });

  // ── props 透传 ───────────────────────────────────────────
  it('sessionId 变化 → InfoPane 与 TerminalPanel 收到新 sessionId', () => {
    const { rerender } = renderDevPanel();
    expect(screen.getByTestId('info-pane').getAttribute('data-session-id')).toBe('session-1');

    rerender(<DevPanel sessionId="session-2" gitRepoPath="/repo" />);
    expect(screen.getByTestId('info-pane').getAttribute('data-session-id')).toBe('session-2');
  });

  it('gitRepoPath 变化 → GitPanel 收到新 path', async () => {
    const { rerender } = renderDevPanel();
    // 通过"+"添加开发者视图
    await userEvent.click(screen.getByRole('button', { name: '添加视图' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: '开发者' }));
    await userEvent.click(screen.getByRole('tab', { name: /开发者/ }));
    expect(screen.getByTestId('git-panel').getAttribute('data-path')).toBe('/repo');

    rerender(<DevPanel sessionId="session-1" gitRepoPath="/repo2" />);
    expect(screen.getByTestId('git-panel').getAttribute('data-path')).toBe('/repo2');
  });

  it('自定义 className 合并到容器', () => {
    renderDevPanel({ className: 'custom-class' });
    expect(document.querySelector('.custom-class')).not.toBeNull();
  });
});
