import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

const { mockReportError } = vi.hoisted(() => ({ mockReportError: vi.fn() }));
vi.mock('@/lib/error-report', () => ({
  reportError: mockReportError,
}));

import { SectionErrorBoundary } from './SectionErrorBoundary';

/** 抛错子组件：首次渲染抛错，重试后（props.attempt > 0）正常渲染 */
function ExplodingChild({ attempt }: { readonly attempt: number }): ReactElement {
  if (attempt === 0) {
    throw new Error('boom');
  }
  return <div data-testid="recovered">recovered</div>;
}

describe('SectionErrorBoundary', () => {
  it('子组件正常：原样渲染', () => {
    render(
      <SectionErrorBoundary>
        <div>content</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('子组件抛错：显示内联 fallback（区块加载失败 + 重试按钮），不抛到外层', () => {
    render(
      <SectionErrorBoundary name="test-section">
        <ExplodingChild attempt={0} />
      </SectionErrorBoundary>,
    );
    expect(screen.getByTestId('section-error-boundary')).toBeTruthy();
    expect(screen.getByText('区块加载失败，请重试')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(mockReportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({
        tags: expect.objectContaining({
          boundary: 'SectionErrorBoundary',
          section: 'test-section',
        }),
      }),
    );
  });

  it('点击重试：resetErrorBoundary 重新渲染子树并恢复', async () => {
    let attempt = 0;
    const { rerender } = render(
      <SectionErrorBoundary>
        <ExplodingChild attempt={attempt} />
      </SectionErrorBoundary>,
    );
    expect(screen.getByTestId('section-error-boundary')).toBeTruthy();

    attempt = 1;
    rerender(
      <SectionErrorBoundary>
        <ExplodingChild attempt={attempt} />
      </SectionErrorBoundary>,
    );
    expect(screen.getByTestId('section-error-boundary')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByTestId('recovered')).toBeTruthy();
    expect(screen.queryByTestId('section-error-boundary')).toBeNull();
  });

  it('非 Error 错误（抛字符串）：fallback 显示 String(error) 文本', () => {
    const ExplodingChild = (): ReactElement => {
      throw 'plain string error';
    };
    expect(() =>
      render(
        <SectionErrorBoundary>
          <ExplodingChild />
        </SectionErrorBoundary>,
      ),
    ).not.toThrow();
    expect(screen.getByTestId('section-error-boundary')).toBeTruthy();
  });

  it('传入 resetKeys：正常渲染不抛', () => {
    render(
      <SectionErrorBoundary resetKeys={['tab-1']}>
        <div data-testid="normal-child">内容</div>
      </SectionErrorBoundary>,
    );
    expect(screen.getByTestId('normal-child')).toBeTruthy();
  });
});
