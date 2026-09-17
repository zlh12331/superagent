// src/renderer/components/$1/AppErrorBoundary.test.tsx
// AppErrorBoundary 单测（第 1 层错误边界：全屏兜底 + 崩溃报障）
// ──────────────────────────────────────────────
// 覆盖动机：组件此前 0% 覆盖。它是应用最外层兜底——全屏降级 UI、
// 崩溃报障深链（标题/正文预填 + 版本环境 + 诊断包引导）、上报统一出口、
// reload 恢复策略均无回归锚。
// 断言策略：mock reportError（避免落盘）、mock window.api（getInfo/openExternal）；
// buildIssueUrl 的拼装经 openExternal 收到的 url 反推验证。
// ──────────────────────────────────────────────

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/i18n';

import { AppErrorBoundary } from './AppErrorBoundary';

const { mockReportError } = vi.hoisted(() => ({ mockReportError: vi.fn() }));
vi.mock('@/lib/error-report', () => ({ reportError: mockReportError }));
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

const t = i18n.t.bind(i18n);

/** window.api 最小挂载（getInfo / openExternal），返回 spy 供断言 */
function mountApi(overrides?: { getInfo?: () => Promise<unknown> }): {
  openExternal: ReturnType<typeof vi.fn>;
} {
  const openExternal = vi.fn().mockResolvedValue({ data: undefined });
  const w = window as unknown as {
    api?: { app: { getInfo: ReturnType<typeof vi.fn>; openExternal: ReturnType<typeof vi.fn> } };
  };
  w.api = {
    app: {
      getInfo: vi.fn(
        overrides?.getInfo ??
          (() =>
            Promise.resolve({
              data: { version: '1.0.0', platform: 'win32', arch: 'x64', electron: '44.0.0' },
            })),
      ),
      openExternal,
    },
  };
  return { openExternal };
}

/** 取第 n 次 openExternal 收到的 url（断言辅助，避免 ?.[0] 链式断言） */
function openedUrl(openExternal: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const call = openExternal.mock.calls[callIndex];
  const arg = (call === undefined ? {} : call[0]) as { url?: string };
  return arg.url ?? '';
}

/** 抛错子组件（首次渲染即抛） */
function Exploding(): ReactElement {
  throw new Error('render boom');
}

describe('AppErrorBoundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mountApi();
  });

  it('正向：子组件正常渲染，无错误 UI', () => {
    render(
      <AppErrorBoundary>
        <div data-testid="ok">正常内容</div>
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeDefined();
    expect(screen.queryByTestId('app-error-boundary')).toBeNull();
  });

  it('异常：子组件抛错 → 全屏兜底 UI + 错误消息可见', () => {
    // 抑制 React 对错误边界的 console.error 噪音
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );
    expect(screen.getByTestId('app-error-boundary')).toBeDefined();
    expect(screen.getByText('render boom')).toBeDefined();
    expect(screen.getByRole('button', { name: t('common.reload') })).toBeDefined();
    spy.mockRestore();
  });

  it('上报：错误经统一出口 reportError，tag 为 AppErrorBoundary', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );
    expect(mockReportError).toHaveBeenCalledTimes(1);
    const [error, options] = mockReportError.mock.calls[0] as [
      Error,
      { tags: { boundary: string } },
    ];
    expect(error.message).toBe('render boom');
    expect(options.tags.boundary).toBe('AppErrorBoundary');
    spy.mockRestore();
  });

  it('报障：点击发送 → 打开预填 issue 深链（标题含 [crash] + 版本环境行）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { openExternal } = mountApi();
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.sendCrashReport') }));

    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledTimes(1);
    });
    const url = openedUrl(openExternal);
    expect(url).toContain('github.com/');
    expect(decodeURIComponent(url)).toContain('[crash] render boom');
    // 版本环境行来自 getInfo（Electron 版本 + 平台）
    expect(decodeURIComponent(url)).toContain('1.0.0');
    expect(decodeURIComponent(url)).toContain('win32/x64');
    spy.mockRestore();
  });

  it('异常边界：getInfo 失败 → 报障深链仍可打开（仅缺版本行，不阻断）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { openExternal } = mountApi({ getInfo: () => Promise.reject(new Error('no api')) });
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.sendCrashReport') }));
    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledTimes(1);
    });
    expect(decodeURIComponent(openedUrl(openExternal))).toContain('render boom');
    spy.mockRestore();
  });

  it('异常边界：openExternal 拒绝 → 弹失败 toast（不抛未捕获异常）', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const openExternal = vi.fn().mockRejectedValue(new Error('denied'));
    const w = window as unknown as { api: { app: { openExternal: ReturnType<typeof vi.fn> } } };
    w.api.app.openExternal = openExternal;
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.sendCrashReport') }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledTimes(1);
    });
    spy.mockRestore();
  });

  it('恢复：点击重新加载 → window.location.reload 被调用', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const reloadSpy = vi.fn();
    const original = window.location;
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...original, reload: reloadSpy },
    });
    render(
      <AppErrorBoundary>
        <Exploding />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: t('common.reload') }));
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    Object.defineProperty(window, 'location', { configurable: true, value: original });
    spy.mockRestore();
  });

  it('异常边界：非 Error 抛出（字符串）→ fallback 显示 String(error)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function ThrowString(): ReactElement {
      throw 'string-error';
      // eslint-disable-next-line no-unreachable
    }
    render(
      <AppErrorBoundary>
        <ThrowString />
      </AppErrorBoundary>,
    );
    expect(screen.getByText('string-error')).toBeDefined();
    spy.mockRestore();
  });
});
