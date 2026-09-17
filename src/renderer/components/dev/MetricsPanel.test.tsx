// src/renderer/components/dev/MetricsPanel.test.tsx
// MetricsPanel 单测/集成（四态渲染 / 指标格式化 / 刷新与禁用语义）
// 策略：mock `@/hooks/use-system`（数据获取边界），组件自身逻辑走真实实现。
// （原 dev-panels.test 按被测组件拆分至此）

import type { SystemStatusRes } from '@code-agent/shared/renderer';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUseSystemStatusQuery, mockUseLogsReadQuery, mockRefetchMetrics } = vi.hoisted(() => ({
  mockUseSystemStatusQuery: vi.fn(),
  mockUseLogsReadQuery: vi.fn(),
  mockRefetchMetrics: vi.fn(),
}));

vi.mock('@/hooks/use-system', () => ({
  useLogsReadQuery: mockUseLogsReadQuery,
  useSystemStatusQuery: mockUseSystemStatusQuery,
}));

import { MetricsPanel } from './MetricsPanel';

const STATUS_SAMPLE: SystemStatusRes = {
  appVersion: '1.2.3',
  electronVersion: '44.0.0',
  nodeVersion: '22.0.0',
  platform: 'win32',
  arch: 'x64',
  isPackaged: false,
  uptimeSeconds: 3661,
  pid: 4242,
  memory: {
    rss: 100 * 1024 * 1024,
    heapTotal: 50 * 1024 * 1024,
    heapUsed: 20 * 1024 * 1024,
    external: 1024 * 1024,
    arrayBuffers: 512 * 1024,
  },
  cpu: { user: 1_500_000, system: 500_000 },
  timestamp: '2026-09-16T04:00:00.000Z',
};

/** 设置 useSystemStatusQuery 返回值 */
function setStatusState(
  overrides?: Partial<{
    data: SystemStatusRes | undefined;
    isLoading: boolean;
    error: Error | null;
    isFetching: boolean;
  }>,
): void {
  mockUseSystemStatusQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: mockRefetchMetrics,
    isFetching: false,
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setStatusState();
});

describe('MetricsPanel', () => {
  it('加载中：渲染骨架屏（6 组 × 2）', () => {
    setStatusState({ isLoading: true });
    render(<MetricsPanel />);
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(12);
  });

  it('查询失败：渲染错误提示 + 已本地化的错误文案', () => {
    // 错误码经 unwrapErrorMessage 解析为 errors.* 文案（此前直出 `[CODE] message`）
    setStatusState({ error: new Error('[INTERNAL_ERROR] 获取失败') });
    render(<MetricsPanel />);
    expect(screen.getByText('指标获取失败')).toBeTruthy();
    expect(screen.getByText('内部错误')).toBeTruthy();
  });

  it('无数据（非加载非错误）：提示指标数据为空', () => {
    render(<MetricsPanel />);
    expect(screen.getByText('指标数据为空')).toBeTruthy();
  });

  it('有数据：内存/CPU/运行时长按档位格式化', () => {
    setStatusState({ data: STATUS_SAMPLE });
    render(<MetricsPanel />);
    expect(screen.getByText('100.0 MB')).toBeTruthy(); // rss
    expect(screen.getByText('20.0 MB')).toBeTruthy(); // heapUsed
    expect(screen.getByText('1.50 s')).toBeTruthy(); // cpu.user
    expect(screen.getByText('1h 1m 1s')).toBeTruthy(); // uptime
  });

  it('有数据：环境信息与 PID 展示', () => {
    setStatusState({ data: STATUS_SAMPLE });
    render(<MetricsPanel />);
    expect(screen.getByText('1.2.3')).toBeTruthy();
    expect(screen.getByText('44.0.0')).toBeTruthy();
    expect(screen.getByText('22.0.0')).toBeTruthy();
    expect(screen.getByText(/win32 \/ x64/)).toBeTruthy();
    expect(screen.getByText('PID 4242')).toBeTruthy();
  });

  it('有数据：打包态标记（isPackaged=true → 打包版）', () => {
    setStatusState({ data: { ...STATUS_SAMPLE, isPackaged: true } });
    render(<MetricsPanel />);
    // 该标记已走 i18n（此前硬编码英文 'packaged'/'dev'）
    expect(screen.getByText(/· 打包版/)).toBeTruthy();
  });

  it('刷新：点击刷新按钮触发 refetch', () => {
    setStatusState({ data: STATUS_SAMPLE });
    render(<MetricsPanel />);
    fireEvent.click(screen.getByLabelText('刷新指标'));
    expect(mockRefetchMetrics).toHaveBeenCalledTimes(1);
  });

  it('刷新中：按钮禁用', () => {
    setStatusState({ isFetching: true });
    render(<MetricsPanel />);
    expect(screen.getByLabelText('刷新指标')).toBeDisabled();
  });

  it('enabled=false：刷新禁用且查询不启用', () => {
    render(<MetricsPanel enabled={false} />);
    expect(screen.getByLabelText('刷新指标')).toBeDisabled();
    expect(mockUseSystemStatusQuery).toHaveBeenCalledWith(false);
  });
});
