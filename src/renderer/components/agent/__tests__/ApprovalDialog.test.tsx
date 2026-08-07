// src/renderer/components/agent/__tests__/ApprovalDialog.test.tsx
// ApprovalDialog 组件测试（真实 approvals-store 注入）
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. pending 为空：不渲染对话框
// 2. enqueue 后：渲染标题/描述/批准/拒绝按钮
// 3. 点击批准：调用 onRespond(approved=true)
// 4. 点击拒绝：调用 onRespond(approved=false)
// ──────────────────────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useApprovalsStore } from '@/stores/transient/approvals-store';
import { ApprovalDialog } from '../ApprovalDialog';

/** 构造审批项并入队（真实 store，符合无 mock 原则） */
function enqueueApproval(
  overrides: Partial<Parameters<ReturnType<typeof useApprovalsStore.getState>['enqueue']>[0]> = {},
) {
  useApprovalsStore.getState().enqueue({
    id: 'approval-1',
    sessionId: 'session-1',
    type: 'run_command',
    title: '执行命令: npm install',
    description: '在工作目录执行 npm install',
    input: { command: 'npm install' },
    createdAt: Date.now(),
    ...overrides,
  });
}

describe('ApprovalDialog', () => {
  const onRespond = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    // 清空审批队列（真实 store 状态重置）
    useApprovalsStore.setState({ pending: [], resolved: [] });
  });

  it('pending 为空：不渲染对话框内容', () => {
    render(<ApprovalDialog onRespond={onRespond} />);
    expect(screen.queryByText(/npm install/)).toBeNull();
  });

  it('pending 非空：渲染标题/描述与批准/拒绝按钮', () => {
    enqueueApproval();
    render(<ApprovalDialog onRespond={onRespond} />);
    // 标题与结构化预览均含 npm install（多元素匹配）
    expect(screen.getAllByText(/npm install/).length).toBeGreaterThan(0);
    expect(screen.getByText(/在工作目录执行 npm install/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '批准' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '拒绝' })).toBeTruthy();
  });

  it('点击批准：onRespond(approvalId, true)', async () => {
    enqueueApproval();
    render(<ApprovalDialog onRespond={onRespond} />);
    await userEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(onRespond).toHaveBeenCalledWith('approval-1', true, false);
  });

  it('点击拒绝：onRespond(approvalId, false)', async () => {
    enqueueApproval();
    render(<ApprovalDialog onRespond={onRespond} />);
    await userEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onRespond).toHaveBeenCalledWith('approval-1', false, false);
  });
});
