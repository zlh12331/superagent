// src/renderer/components/common/error-boundary-fallback-wiring.test.tsx
// 错误边界 fallback 挂载方式的不变量测试（防 React Compiler 击穿兜底）
// ──────────────────────────────────────────────────────────────
// 背景（2026-09-28 实测事故）：react-error-boundary 的 `fallbackRender` 是
// **直接函数调用**（dist 内 `i = t(u)`），而 React Compiler 会给所有组件函数
// 注入 memo 缓存 hook（`_c()` = useMemoCache）；类组件 render 路径不设置 hooks
// dispatcher ⇒ 直接调用即抛「Invalid hook call」⇒ 局部错误升级为整页崩溃，
// 兜底自身失效（浏览器 E2E 旅程批量失败的真实根因链）。
// `FallbackComponent` 走 createElement（React 组件渲染路径，dispatcher 正常）。
//
// 为什么用 props 契约断言而非渲染行为断言：vitest 链路**不跑 React Compiler**
// （见 AGENTS.md），未编译时两种挂载方式行为一致，行为断言无法区分；此处锚定
// 「以组件身份挂载」这一编译后唯一正确的形态，把事故模式钉在单测层。
// ────────────────────────────────────────────────────────────────────

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from './AppErrorBoundary';
import { SectionErrorBoundary } from './SectionErrorBoundary';

/** 捕获到的 ErrorBoundary props（每次渲染覆盖） */
let captured: Record<string, unknown> | null = null;

vi.mock('react-error-boundary', () => ({
  // 替身：只捕获 props 并透传 children，不实现错误捕获
  // biome-ignore lint/style/useNamingConvention: 对齐被替身模块的导出名
  ErrorBoundary: (props: { children?: ReactNode }): ReactNode => {
    captured = props as unknown as Record<string, unknown>;
    return props.children;
  },
}));

vi.mock('@/lib/error-report', () => ({ reportError: vi.fn() }));

describe('错误边界 fallback 挂载方式（React Compiler 安全）', () => {
  beforeEach(() => {
    captured = null;
  });

  it('SectionErrorBoundary：以 FallbackComponent 挂载（组件渲染路径，非 fallbackRender）', () => {
    render(
      <SectionErrorBoundary name="probe">
        <div data-testid="child" />
      </SectionErrorBoundary>,
    );
    expect(captured).not.toBeNull();
    expect(typeof captured?.['FallbackComponent']).toBe('function');
    // fallbackRender 是直接函数调用路径：编译后的 fallback 在此抛 Invalid hook call
    expect(captured?.['fallbackRender']).toBeUndefined();
  });

  it('AppErrorBoundary：以 FallbackComponent 挂载（同上；最后一道兜底不得自崩）', () => {
    render(
      <AppErrorBoundary>
        <div data-testid="child" />
      </AppErrorBoundary>,
    );
    expect(captured).not.toBeNull();
    expect(typeof captured?.['FallbackComponent']).toBe('function');
    expect(captured?.['fallbackRender']).toBeUndefined();
  });

  it('fallback 组件可被独立渲染（不依赖边界宿主上下文）', () => {
    render(
      <SectionErrorBoundary name="probe">
        <div />
      </SectionErrorBoundary>,
    );
    const Fallback = captured?.['FallbackComponent'] as (props: {
      error: unknown;
      resetErrorBoundary: () => void;
    }) => ReactNode;
    const { getByTestId } = render(
      Fallback({
        error: new Error('boom'),
        resetErrorBoundary: (): void => undefined,
      }),
    );
    expect(getByTestId('section-error-boundary')).toBeTruthy();
  });
});
