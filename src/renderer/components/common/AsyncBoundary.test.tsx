import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsyncView } from '@/hooks/use-async-view';
import { useUiStore } from '@/stores/transient/ui-store';
import { AsyncBoundary } from './AsyncBoundary';

const skeleton = <div data-testid="skeleton">骨架</div>;
const empty = <div data-testid="empty">空态</div>;

afterEach(() => {
  useUiStore.setState({ settingsOpen: false });
});

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

  it('error（注册错误码）：额外渲染「去配置」恢复动作并打开设置', () => {
    renderView({
      state: 'error',
      error: new Error('[AI_API_KEY_MISSING] no key'),
      retry: () => {},
    });
    fireEvent.click(screen.getByRole('button', { name: /去配置/ }));
    expect(useUiStore.getState().settingsOpen).toBe(true);
  });

  it('error（未注册错误码）：仅默认重试按钮，无「去配置」', () => {
    renderView({
      state: 'error',
      error: new Error('[FS_READ_FAILED] boom'),
      retry: () => {},
    });
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /去配置/ })).toBeNull();
  });

  it('loading（默认延迟）：200ms 内不闪骨架屏，超时才显示', async () => {
    vi.useFakeTimers();
    try {
      render(
        <AsyncBoundary
          view={{ state: 'loading' } as AsyncView<string[]>}
          skeleton={skeleton}
          empty={empty}
        >
          {(data) => <div>{data.join(',')}</div>}
        </AsyncBoundary>,
      );
      expect(screen.getByRole('status')).toBeTruthy();
      expect(screen.queryByTestId('skeleton')).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.getByTestId('skeleton')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('loading（延迟未到即卸载）：清理定时器，不产生卸载后 setState', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error');
    try {
      const { unmount } = render(
        <AsyncBoundary
          view={{ state: 'loading' } as AsyncView<string[]>}
          skeleton={skeleton}
          empty={empty}
        >
          {(data) => <div>{data.join(',')}</div>}
        </AsyncBoundary>,
      );
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(200);
      });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
