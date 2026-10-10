import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from './AppErrorBoundary';
import { SectionErrorBoundary } from './SectionErrorBoundary';

/** 捕获到的 ErrorBoundary props（每次渲染覆盖） */
let captured: Record<string, unknown> | null = null;

vi.mock('react-error-boundary', () => ({
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
