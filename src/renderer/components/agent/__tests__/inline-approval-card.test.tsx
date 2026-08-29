// src/renderer/components/agent/__tests__/inline-approval-card.test.tsx
// InlineApprovalCard 单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. pending：渲染类型标题 + 三按钮（拒绝/批准并记住/批准）
// 2. 点击拒绝 → store 移入 resolved（rejected）+ 显示「编辑后重提」「跳过」
// 3. 点击编辑后重提 → onEditResubmit 收到命令（run_command 提取 input.command）
// 4. 点击跳过 → 卡片半透明（opacity-40）+ toast「已跳过」
// 5. 非 run_command 类型不显示编辑重提（仅跳过）
// ──────────────────────────────────────────────────────────────

import { REMEMBER_TTL_MINUTES } from '@code-agent/shared/renderer';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '@/providers/ThemeProvider';
import { type ApprovalItem, useApprovalsStore } from '@/stores/transient/approvals-store';
import { InlineApprovalCard } from '../inline-approval-card';

// mock sonner toast（测试环境无 Toaster 挂载，避免真实渲染依赖）
const { mockToastInfo } = vi.hoisted(() => ({ mockToastInfo: vi.fn() }));
vi.mock('sonner', () => ({
  toast: { info: mockToastInfo },
}));

function makeItem(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'a1',
    sessionId: 'session-1',
    type: 'run_command',
    status: 'pending',
    title: 'exec_command',
    description: '执行命令: npm install axios',
    input: { command: 'npm install axios', cwd: 'f:\\proj' },
    createdAt: Date.now(),
    resolvedAt: null,
    ...overrides,
  };
}

function renderCard(overrides: Partial<Parameters<typeof InlineApprovalCard>[0]> = {}) {
  const props = {
    sessionId: 'session-1',
    onEditResubmit: vi.fn(),
    ...overrides,
  };
  render(
    <ThemeProvider>
      <InlineApprovalCard {...props} />
    </ThemeProvider>,
  );
  return props;
}

describe('InlineApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useApprovalsStore.setState({ pending: [], resolved: [] });
    // 审批响应回传 mock（respond 调用 window.api.agent.approvalResponse）
    window.api.agent = {
      approvalResponse: vi.fn().mockResolvedValue({ data: { ok: true } }),
    } as never;
  });

  it('pending：渲染类型标题 + 拒绝/批准并记住/批准 三按钮', () => {
    useApprovalsStore.setState({ pending: [makeItem()] });
    renderCard();

    expect(screen.getByText('执行命令')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: `批准并记住（${REMEMBER_TTL_MINUTES} 分钟）` }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准' })).toBeInTheDocument();
  });

  it('点击拒绝 → 显示「编辑后重提」+「跳过」按钮', () => {
    useApprovalsStore.setState({ pending: [makeItem()] });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    // store 移入 resolved（rejected）
    expect(useApprovalsStore.getState().pending).toHaveLength(0);
    expect(useApprovalsStore.getState().resolved[0]?.status).toBe('rejected');
    // 拒绝后操作按钮
    expect(screen.getByRole('button', { name: '编辑后重提' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument();
  });

  it('点击「编辑后重提」→ onEditResubmit 收到 run_command 命令', () => {
    useApprovalsStore.setState({ pending: [makeItem()] });
    const props = renderCard();

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    fireEvent.click(screen.getByRole('button', { name: '编辑后重提' }));

    expect(props.onEditResubmit).toHaveBeenCalledWith('npm install axios');
  });

  it('点击「跳过」→ 卡片半透明 + toast 提示', () => {
    useApprovalsStore.setState({ pending: [makeItem()] });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    fireEvent.click(screen.getByRole('button', { name: '跳过' }));

    // 半透明
    const card = screen.getByRole('alert');
    expect(card.className).toContain('opacity-40');
    // toast 调用（sonner mock）
    expect(mockToastInfo).toHaveBeenCalledWith('已跳过');
  });

  it('非 run_command 类型（如 git_commit）：拒绝后仅「跳过」无「编辑后重提」', () => {
    useApprovalsStore.setState({
      pending: [makeItem({ type: 'git_commit', input: { message: 'feat: x' } })],
    });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));

    expect(screen.queryByRole('button', { name: '编辑后重提' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '跳过' })).toBeInTheDocument();
  });

  it('无审批项时不渲染', () => {
    renderCard();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
