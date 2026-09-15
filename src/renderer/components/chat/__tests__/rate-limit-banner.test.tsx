// rate-limit-banner.test.tsx
// 限流横幅单测：显隐 / 过期 / 手动关闭 / 自动隐藏定时器（fake timers）
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRateLimitStore } from '@/stores/transient/rate-limit-store';

import { RateLimitBanner } from '../rate-limit-banner';

describe('RateLimitBanner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // triggeredAt 为 number 类型（不可 null），仅重置可见性
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

  it('异常路径：未过期时到点复查不清除（定时器兜底不误关）', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // 仅过 1 分钟（< 5 分钟过期线）：横幅仍在
    expect(useRateLimitStore.getState().visible).toBe(true);
  });

  it('自动隐藏：时间推进至过期后，下一次到点复查触发 dismiss', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);
    act(() => {
      // 系统时间推到过期之后（6 分钟），再走到下一次 60s 检查点
      vi.setSystemTime(Date.now() + 6 * 60_000);
      vi.advanceTimersByTime(60_000);
    });
    expect(useRateLimitStore.getState().visible).toBe(false);
  });
});
