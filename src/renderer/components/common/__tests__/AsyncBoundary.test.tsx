// src/renderer/components/common/__tests__/AsyncBoundary.test.tsx
// AsyncBoundary 渲染层单测：五态渲染 + 防闪烁 + 可操作错误 + a11y
// 直接构造 AsyncView（discriminated union）驱动各状态，无需真实 query。

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AsyncView } from '@/hooks/use-async-view';
import { AsyncBoundary } from '../AsyncBoundary';

const skeleton = <div data-testid="skeleton">骨架</div>;
const empty = <div data-testid="empty">空态</div>;

function renderView(view: AsyncView<string[]>) {
  return render(
    <AsyncBoundary view={view} skeleton={skeleton} empty={empty} skeletonDelay={0}>
      {(data) => <div data-testid="content">{data.join(',')}</div>}
    </AsyncBoundary>,
  );
}

describe('AsyncBoundary', () => {
  it('ready：渲染内容', () => {
    renderView({ state: 'ready', data: ['a', 'b'] });
    expect(screen.getByTestId('content').textContent).toBe('a,b');
  });

  it('refreshing：保留旧数据渲染内容 + 顶部进度条指示刷新中', () => {
    renderView({ state: 'refreshing', data: ['x'] });
    expect(screen.getByTestId('content').textContent).toBe('x');
    // 进度条存在且对读屏隐藏（aria-hidden，不干扰 role=status/alert 语义）
    const bar = screen.getByTestId('refreshing-bar');
    expect(bar.getAttribute('aria-hidden')).toBe('true');
  });

  it('empty：渲染空态', () => {
    renderView({ state: 'empty' });
    expect(screen.getByTestId('empty')).toBeTruthy();
  });

  it('loading：skeletonDelay=0 立即渲染骨架并带 aria-busy', () => {
    renderView({ state: 'loading' });
    expect(screen.getByTestId('skeleton')).toBeTruthy();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('error（默认）：渲染可操作错误（role=alert + 重试按钮）', () => {
    renderView({
      state: 'error',
      error: new Error('出错了'),
      retry: () => {},
    });
    expect(screen.getByRole('alert')).toBeTruthy();
    // i18n 固定 zh-CN（setup-lang.ts），common.retry = "重试"
    expect(screen.getByText('重试')).toBeTruthy();
  });

  it('error（自定义 errorHint）：优先使用调用方渲染', () => {
    render(
      <AsyncBoundary
        view={
          {
            state: 'error',
            error: new Error('e'),
            retry: () => {},
          } as AsyncView<string[]>
        }
        skeleton={skeleton}
        empty={empty}
        errorHint={() => <div data-testid="custom-error">自定义</div>}
      >
        {(data) => <div>{data.join(',')}</div>}
      </AsyncBoundary>,
    );
    expect(screen.getByTestId('custom-error')).toBeTruthy();
  });
});
