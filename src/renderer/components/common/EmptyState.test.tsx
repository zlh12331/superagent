// src/renderer/components/common/__tests__/EmptyState.test.tsx
// EmptyState 空态组件单测：标题/描述/CTA/自定义图标
// 纯展示组件（props 驱动），无需 i18n 与 query。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('渲染标题与描述', () => {
    render(<EmptyState title="暂无会话" description="点击新建开始" />);
    expect(screen.getByText('暂无会话')).toBeTruthy();
    expect(screen.getByText('点击新建开始')).toBeTruthy();
  });

  it('提供 actionLabel 时渲染 CTA，点击触发 onAction', () => {
    const onAction = vi.fn();
    render(<EmptyState title="暂无会话" actionLabel="新建会话" onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: '新建会话' }));
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('未提供 actionLabel 时不渲染按钮', () => {
    render(<EmptyState title="暂无会话" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('未传 icon 时使用默认 Inbox 图标', () => {
    render(<EmptyState title="暂无会话" />);
    expect(screen.getByTestId('empty-default-icon')).toBeTruthy();
  });

  it('自定义 icon 优先于默认 Inbox', () => {
    render(<EmptyState title="暂无会话" icon={<span data-testid="custom-icon">C</span>} />);
    expect(screen.getByTestId('custom-icon')).toBeTruthy();
    expect(screen.queryByTestId('empty-default-icon')).toBeNull();
  });
});
