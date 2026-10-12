import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_HIDE_MS, useRateLimitStore } from '@/stores/transient/rate-limit-store';

import { RateLimitBanner } from './rate-limit-banner';

describe('RateLimitBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useRateLimitStore.setState({ visible: false });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('visible=false：不渲染', () => {
    const { container } = render(<RateLimitBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('正向：限流触发（未过期）→ 渲染提示（Alert role）+ 关闭按钮', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: /关闭/ })).toBeDefined();
  });

  it('边界：触发已超 5 分钟（渲染期判定过期）→ 不渲染', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() - 6 * 60_000 });
    const { container } = render(<RateLimitBanner />);
    expect(container.firstChild).toBeNull();
  });

  it('手动关闭：点击 × → store.visible=false → 横幅消失', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);
    fireEvent.click(screen.getByRole('button', { name: /关闭/ }));
    expect(useRateLimitStore.getState().visible).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('异常路径：未到过期时刻不清除（定时器不误关）', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(useRateLimitStore.getState().visible).toBe(true);
  });

  it('自动隐藏：推进到过期时刻（5 分钟）→ dismiss', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);

    act(() => {
      vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
    });
    expect(useRateLimitStore.getState().visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useRateLimitStore.getState().visible).toBe(false);
  });

  it('重复限流：刷新 triggeredAt 后按新时刻重新计时', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);

    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    act(() => {
      useRateLimitStore.getState().trigger();
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(useRateLimitStore.getState().visible).toBe(true);

    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(useRateLimitStore.getState().visible).toBe(false);
  });
});
