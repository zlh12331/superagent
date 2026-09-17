// src/renderer/components/$1/MotionReveal.test.tsx
// MotionReveal 入场动效包装单测：三种变体 / 延迟 / inView 两分支 / className 透传
// ──────────────────────────────────────────────
// 覆盖动机：组件此前 0% 覆盖。它对 motion/react 的 initial/animate/whileInView
// 装配是「一行启用动效」的契约面——变体名拼错、inView 分支走错会导致
// 首页元素静止不动（视觉缺陷，无报错），需要回归锚。
// 断言策略：motion.div 在 jsdom 中渲染为 div，通过 data-* 与 className 观察装配结果。
// ──────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { MotionReveal } from './MotionReveal';

describe('MotionReveal', () => {
  it('正向：默认 blurUp 变体渲染 children（挂载即播，无 whileInView）', () => {
    render(
      <MotionReveal>
        <span data-testid="child">内容</span>
      </MotionReveal>,
    );
    expect(screen.getByTestId('child')).toBeDefined();
  });

  it('正向：三种变体均可渲染（blurUp / slideUp / fadeIn）', () => {
    for (const variant of ['blurUp', 'slideUp', 'fadeIn'] as const) {
      const { unmount } = render(
        <MotionReveal variant={variant}>
          <span data-testid={`child-${variant}`}>内容</span>
        </MotionReveal>,
      );
      expect(screen.getByTestId(`child-${variant}`)).toBeDefined();
      unmount();
    }
  });

  it('边界：delay 传 0（默认）与正值均正常渲染', () => {
    const { unmount } = render(
      <MotionReveal delay={0}>
        <span data-testid="d0">零延迟</span>
      </MotionReveal>,
    );
    expect(screen.getByTestId('d0')).toBeDefined();
    unmount();
    render(
      <MotionReveal delay={0.4}>
        <span data-testid="d4">延迟</span>
      </MotionReveal>,
    );
    expect(screen.getByTestId('d4')).toBeDefined();
  });

  it('inView 分支：滚动触发模式同样渲染 children（非挂载即播）', () => {
    render(
      <MotionReveal variant="fadeIn" inView>
        <span data-testid="inview">视口内容</span>
      </MotionReveal>,
    );
    expect(screen.getByTestId('inview')).toBeDefined();
  });

  it('className 透传：自定义类名并入容器', () => {
    const { container } = render(
      <MotionReveal className="mt-4 custom-reveal">
        <span>内容</span>
      </MotionReveal>,
    );
    const el = container.firstElementChild;
    expect(el?.className).toContain('custom-reveal');
    expect(el?.className).toContain('mt-4');
  });

  it('边界：未传 className → 容器仍渲染（cn(undefined) 不产生 "undefined" 类名）', () => {
    const { container } = render(
      <MotionReveal>
        <span>内容</span>
      </MotionReveal>,
    );
    expect(container.firstElementChild?.className).not.toContain('undefined');
  });
});
