// src/renderer/components/layout/__tests__/goal-edit-dialog.test.tsx
// GoalEditDialog 单元测试
// ──────────────────────────────────────────────────────────────
// 测试要点：
// 1. 无目标（initialCondition 空）→ 标题「设置会话目标」+ 空输入 + 提交禁用
// 2. 有目标 → 标题「编辑会话目标」+ 输入框预填
// 3. 输入后提交 → onSubmit 收到 trim 后的条件
// 4. 取消 → onOpenChange(false)
// ──────────────────────────────────────────────────────────────

import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { GoalEditDialog } from '../goal-edit-dialog';

function renderDialog(overrides: Partial<Parameters<typeof GoalEditDialog>[0]> = {}) {
  const props = {
    open: true,
    onOpenChange: vi.fn(),
    initialCondition: '',
    onSubmit: vi.fn(),
    ...overrides,
  };
  render(<GoalEditDialog {...props} />);
  return props;
}

describe('GoalEditDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('无目标：标题「设置会话目标」+ 空输入框 + 提交按钮禁用', () => {
    renderDialog();

    expect(screen.getByText('设置会话目标')).toBeInTheDocument();
    expect(screen.getByLabelText('目标完成条件')).toHaveValue('');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });

  it('有目标：标题「编辑会话目标」+ 输入框预填', () => {
    renderDialog({ initialCondition: '修复登录页 500 错误' });

    expect(screen.getByText('编辑会话目标')).toBeInTheDocument();
    expect(screen.getByLabelText('目标完成条件')).toHaveValue('修复登录页 500 错误');
    // 有内容时保存可用
    expect(screen.getByRole('button', { name: '保存' })).toBeEnabled();
  });

  it('输入后点击保存 → onSubmit 收到 trim 后条件', () => {
    const props = renderDialog();

    fireEvent.change(screen.getByLabelText('目标完成条件'), {
      target: { value: '  完成用户中心  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(props.onSubmit).toHaveBeenCalledWith('完成用户中心');
  });

  it('取消按钮 → onOpenChange(false)', () => {
    const props = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('仅空白输入时提交禁用（trim 后为空）', () => {
    renderDialog();

    fireEvent.change(screen.getByLabelText('目标完成条件'), { target: { value: '   ' } });
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
  });
});
