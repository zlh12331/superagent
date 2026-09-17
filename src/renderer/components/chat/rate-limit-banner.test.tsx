// rate-limit-banner.test.tsx
// 限流横幅单测：显隐 / 过期 / 手动关闭 / 自动隐藏定时器（fake timers）
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTO_HIDE_MS, useRateLimitStore } from '@/stores/transient/rate-limit-store';

import { RateLimitBanner } from './rate-limit-banner';

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

  it('异常路径：未到过期时刻不清除（定时器不误关）', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // 仅过 1 分钟（< 5 分钟过期线）：横幅仍在
    expect(useRateLimitStore.getState().visible).toBe(true);
  });

  // ── 到期自动隐藏（2026-09 审计修复的回归锚） ───────────────────
  //
  // 背景：此前只挂一个固定 60s 的一次性定时器，60s 到点未过期即静默结束、
  // 定时器不再重排 → 之后永远不会 dismiss，横幅需等无关重渲染才可能消失。
  // 旧测试用 `setSystemTime(+6min)` + `advanceTimersByTime(60s)` 恰好把这个
  // 缺陷绕过（跳墙钟后那唯一一次定时器复查刚好看到「已过期」）。
  // 现按剩余时间精确调度到过期时刻，测试直接推进到过期点。

  it('自动隐藏：推进到过期时刻（5 分钟）→ dismiss', () => {
    useRateLimitStore.setState({ visible: true, triggeredAt: Date.now() });
    render(<RateLimitBanner />);

    act(() => {
      // 距过期还差 1ms：仍在
      vi.advanceTimersByTime(AUTO_HIDE_MS - 1);
    });
    expect(useRateLimitStore.getState().visible).toBe(true);

    act(() => {
      // 到点：应自动隐藏
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
    // 再触发一次限流（刷新触发时刻）
    act(() => {
      useRateLimitStore.getState().trigger();
    });
    // 距首次触发已 5 分钟，但距新触发仅 1 分钟 → 不应被清掉
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(useRateLimitStore.getState().visible).toBe(true);

    // 走到新触发后的 5 分钟 → 隐藏
    act(() => {
      vi.advanceTimersByTime(4 * 60_000);
    });
    expect(useRateLimitStore.getState().visible).toBe(false);
  });
});
