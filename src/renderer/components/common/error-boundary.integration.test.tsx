// src/renderer/components/common/__tests__/error-boundary.integration.test.tsx
// 错误边界分层体系集成测试：App 级 → Section 级嵌套降级行为
// ──────────────────────────────────────────────
// 覆盖动机：三层错误边界（App / Route / Section）的价值在**嵌套**时才体现——
// Section 级捕获后 App 级不应被触发（局部降级不升级为全屏崩溃）。
// 单测各自独立验证，但没有「嵌套隔离」这条集成契约的回归锚。
// 同时验证与 AsyncBoundary 的协作：区块内查询失败 → 局部错误 UI，
// 而非全屏兜底。
// ──────────────────────────────────────────────

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { AppErrorBoundary } from './AppErrorBoundary';
import { AsyncBoundary } from './AsyncBoundary';
import { SectionErrorBoundary } from './SectionErrorBoundary';

const { mockReportError } = vi.hoisted(() => ({ mockReportError: vi.fn() }));
vi.mock('@/lib/error-report', () => ({ reportError: mockReportError }));

const t = i18n.t.bind(i18n);

/** 抛错子组件 */
function Boom(): ReactElement {
  throw new Error('section boom');
}

describe('错误边界分层集成', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = window as unknown as { api?: { app?: unknown } };
    w.api = {
      app: {
        getInfo: vi.fn(async () => ({ data: { version: '1.0.0', platform: 'win32' } })),
        openExternal: vi.fn(async () => ({ data: undefined })),
      },
    } as never;
  });

  it('嵌套隔离：Section 级捕获错误后，App 级保持正常（局部降级不升级为全屏崩溃）', () => {
    render(
      <AppErrorBoundary>
        <div data-testid="healthy">健康区块</div>
        <SectionErrorBoundary name="settings">
          <Boom />
        </SectionErrorBoundary>
      </AppErrorBoundary>,
    );
    // 局部降级：Section fallback 出现
    expect(screen.getByTestId('section-error-boundary')).toBeDefined();
    // App 级未被触发：无全屏兜底，且健康区块仍在
    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
    expect(screen.getByTestId('healthy')).toBeDefined();
  });

  it('上报分层：Section 捕获只上报一次，且 tag 标注区块名', () => {
    render(
      <AppErrorBoundary>
        <SectionErrorBoundary name="right-panel">
          <Boom />
        </SectionErrorBoundary>
      </AppErrorBoundary>,
    );
    expect(mockReportError).toHaveBeenCalledTimes(1);
    const [, options] = mockReportError.mock.calls[0] as [
      Error,
      { tags: { boundary: string; section: string } },
    ];
    expect(options.tags.boundary).toBe('SectionErrorBoundary');
    expect(options.tags.section).toBe('right-panel');
  });

  it('升级路径：无 Section 包裹时，错误冒泡至 App 级全屏兜底', () => {
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('app-error-boundary')).toBeDefined();
    const [, options] = mockReportError.mock.calls[0] as [Error, { tags: { boundary: string } }];
    expect(options.tags.boundary).toBe('AppErrorBoundary');
  });

  it('多区块独立：一个区块崩溃不影响另一区块渲染', () => {
    render(
      <AppErrorBoundary>
        <SectionErrorBoundary name="a">
          <Boom />
        </SectionErrorBoundary>
        <SectionErrorBoundary name="b">
          <div data-testid="b-ok">B 区块正常</div>
        </SectionErrorBoundary>
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('section-error-boundary')).toBeDefined();
    expect(screen.getByTestId('b-ok')).toBeDefined();
    // 仅上报一次（A 区块的错误）
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it('与 AsyncBoundary 协作：查询错误走局部错误 UI（role=alert），不触发任何错误边界', () => {
    render(
      <AppErrorBoundary>
        <SectionErrorBoundary name="usage">
          <AsyncBoundary
            view={{
              state: 'error',
              error: new Error('[AI_MODEL_NOT_CONFIGURED] 未配置'),
              retry: vi.fn(),
            }}
            skeleton={<div />}
            empty={<div />}
          >
            {() => <div data-testid="never">不应渲染</div>}
          </AsyncBoundary>
        </SectionErrorBoundary>
      </AppErrorBoundary>,
    );
    // 查询失败是「预期内的数据态」，由 AsyncBoundary 的 role=alert 呈现
    expect(screen.getByRole('alert')).toBeDefined();
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeDefined();
    // 不应升级为错误边界（两者职责不同：数据态 vs 渲染异常）
    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
    expect(screen.queryByTestId('section-error-boundary')).toBeNull();
    expect(mockReportError).not.toHaveBeenCalled();
  });
});
