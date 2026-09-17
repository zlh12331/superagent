// src/renderer/components/dev/__tests__/dev-panels.test.tsx
// 开发者工具三面板单测/集成（LogsPanel / MetricsPanel / InspectorPanel）
// ──────────────────────────────────────────────────────────────
// 这三个面板此前只被 layout/__tests__/DevPanel.test.tsx 以 mock 形式引用，
// 自身零直接覆盖。此处覆盖其四态渲染（加载/错误/无数据/有数据）、
// 过滤与行数交互、查询参数、刷新与禁用语义，以及 InspectorPanel 的
// IPC 结果分流与状态自动清除。
//
// 策略：mock `@/hooks/use-system`（数据获取边界，沿用 GitPanel 测试的做法），
// 组件自身逻辑走真实实现。
// ──────────────────────────────────────────────────────────────

import type { ReadLogsRes, SystemStatusRes } from '@code-agent/shared/renderer';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockUseLogsReadQuery,
  mockUseSystemStatusQuery,
  mockRefetchLogs,
  mockRefetchMetrics,
  mockOpenDevtools,
} = vi.hoisted(() => ({
  mockUseLogsReadQuery: vi.fn(),
  mockUseSystemStatusQuery: vi.fn(),
  mockRefetchLogs: vi.fn(),
  mockRefetchMetrics: vi.fn(),
  mockOpenDevtools: vi.fn(),
}));

vi.mock('@/hooks/use-system', () => ({
  useLogsReadQuery: mockUseLogsReadQuery,
  useSystemStatusQuery: mockUseSystemStatusQuery,
}));

import { InspectorPanel } from './InspectorPanel';
import { LogsPanel } from './LogsPanel';
import { MetricsPanel } from './MetricsPanel';

// ── 测试数据 ────────────────────────────────────────────────

const LOGS_SAMPLE: ReadLogsRes = {
  lines: ['[info] started', '[error] boom', '[warn] careful'],
  total: 3,
  filePath: '/tmp/main.log',
  truncated: false,
};

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

/** 设置 useLogsReadQuery 返回值（未指定的字段取「无数据、非加载、无错误」） */
function setLogsState(
  overrides?: Partial<{
    data: ReadLogsRes | undefined;
    isLoading: boolean;
    error: Error | null;
    isFetching: boolean;
  }>,
): void {
  mockUseLogsReadQuery.mockReturnValue({
    data: undefined,
    isLoading: false,
    error: null,
    refetch: mockRefetchLogs,
    isFetching: false,
    ...overrides,
  });
}

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

/** 最近一次 useLogsReadQuery 调用参数（lines, level, enabled） */
function lastLogsArgs(): readonly unknown[] {
  return (mockUseLogsReadQuery.mock.calls.at(-1) ?? []) as readonly unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  setLogsState();
  setStatusState();
});

// ── LogsPanel ───────────────────────────────────────────────

describe('LogsPanel', () => {
  it('加载中：渲染骨架屏（8 行占位）', () => {
    setLogsState({ isLoading: true });
    render(<LogsPanel />);
    expect(document.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(8);
  });

  it('查询失败：渲染错误提示 + 已本地化的错误文案', () => {
    // 错误码经 unwrapErrorMessage 解析为 errors.* 文案（此前直出 `[CODE] message`）
    setLogsState({ error: new Error('[FS_READ_FAILED] 读取失败') });
    render(<LogsPanel />);
    expect(screen.getByText('日志获取失败')).toBeTruthy();
    expect(screen.getByText('文件读取失败')).toBeTruthy();
  });

  it('无数据（非加载非错误）：提示日志面板为空', () => {
    render(<LogsPanel />);
    expect(screen.getByText('日志面板为空')).toBeTruthy();
  });

  it('空日志（lines 为空）：渲染空态 + 文件路径', () => {
    setLogsState({ data: { lines: [], total: 0, filePath: '/tmp/main.log', truncated: false } });
    render(<LogsPanel />);
    expect(screen.getByText('暂无日志')).toBeTruthy();
    expect(screen.getByText('/tmp/main.log')).toBeTruthy();
  });

  it('有日志：渲染全部行 + 行数统计', () => {
    setLogsState({ data: LOGS_SAMPLE });
    render(<LogsPanel />);
    expect(screen.getByText('[info] started')).toBeTruthy();
    expect(screen.getByText('[error] boom')).toBeTruthy();
    // 统计显示 total（未截断时不带截断标记）
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('有日志：按行内级别标记着色（四档 + 无标记兜底色）', () => {
    setLogsState({
      data: {
        lines: ['[error] e', '[warn] w', '[debug] d', '[info] i', 'plain line'],
        total: 5,
        filePath: '/tmp/main.log',
        truncated: false,
      },
    });
    render(<LogsPanel />);
    expect(screen.getByText('[error] e').className).toContain('text-error-text');
    expect(screen.getByText('[warn] w').className).toContain('text-warn-text');
    expect(screen.getByText('[debug] d').className).toContain('text-muted-foreground');
    expect(screen.getByText('[info] i').className).toContain('text-foreground/80');
    // 无级别标记：走兜底色
    expect(screen.getByText('plain line').className).toContain('text-muted-foreground');
  });

  it('截断提示：truncated=true 时在统计后追加标记', () => {
    setLogsState({ data: { ...LOGS_SAMPLE, truncated: true, total: 9999 } });
    render(<LogsPanel />);
    expect(screen.getByText(/9999/)).toBeTruthy();
    expect(screen.getByText(/截断/)).toBeTruthy();
  });

  it('空行：渲染为单个空格占位（保持行高不塌陷）', () => {
    setLogsState({
      data: { lines: ['', '[info] after'], total: 2, filePath: '/tmp/main.log', truncated: false },
    });
    const { container } = render(<LogsPanel />);
    const rows = container.querySelectorAll('pre > div');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toBe(' ');
    expect(rows[1]?.textContent).toBe('[info] after');
  });

  it('级别过滤：默认不传 level（all 等价于不筛选）', () => {
    render(<LogsPanel />);
    expect(lastLogsArgs()).toEqual([200, undefined, true]);
  });

  it('级别过滤：选择 Error → 查询带 level=error', () => {
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: 'Error' }));
    expect(lastLogsArgs()).toEqual([200, 'error', true]);
  });

  it('级别过滤：点击当前已选项（Radix 单选取消 → 空串）不得改变查询参数', () => {
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: '全部' }));
    expect(lastLogsArgs()).toEqual([200, undefined, true]);
  });

  it('行数选择：切换为 500 → 查询带 lines=500', () => {
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: '500' }));
    expect(lastLogsArgs()).toEqual([500, undefined, true]);
  });

  it('行数选择：点击当前已选项（取消 → 空串）不得把行数置 0', () => {
    render(<LogsPanel />);
    fireEvent.click(screen.getByRole('radio', { name: '200' }));
    expect(lastLogsArgs()).toEqual([200, undefined, true]);
  });

  it('刷新：点击刷新按钮触发 refetch', () => {
    render(<LogsPanel />);
    fireEvent.click(screen.getByLabelText('刷新日志'));
    expect(mockRefetchLogs).toHaveBeenCalledTimes(1);
  });

  it('刷新中：按钮禁用', () => {
    setLogsState({ isFetching: true });
    render(<LogsPanel />);
    expect(screen.getByLabelText('刷新日志')).toBeDisabled();
  });

  it('enabled=false：过滤/行数/刷新全部禁用，查询不启用', () => {
    render(<LogsPanel enabled={false} />);
    expect(screen.getByRole('radio', { name: '全部' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: '100' })).toBeDisabled();
    expect(screen.getByLabelText('刷新日志')).toBeDisabled();
    expect(lastLogsArgs()).toEqual([200, undefined, false]);
  });
});

// ── MetricsPanel ────────────────────────────────────────────

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

// ── InspectorPanel ──────────────────────────────────────────

describe('InspectorPanel', () => {
  beforeEach(() => {
    window.api = { devtools: { open: mockOpenDevtools } } as never;
  });

  it('渲染三个停靠模式按钮 + React DevTools 说明文案', () => {
    render(<InspectorPanel />);
    expect(screen.getByText('独立窗口')).toBeTruthy();
    expect(screen.getByText('右侧')).toBeTruthy();
    expect(screen.getByText('底部')).toBeTruthy();
    // 文案已从硬编码迁移到 i18n（dev.reactDevtoolsDesc）
    expect(screen.getByText(/electron-devtools-installer/)).toBeTruthy();
  });

  it('成功：以所选模式调用 IPC 并提示已打开', async () => {
    mockOpenDevtools.mockResolvedValue({ data: { ok: true, mode: 'detach' } });
    render(<InspectorPanel />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('以独立窗口 模式打开 DevTools'));
    });
    expect(mockOpenDevtools).toHaveBeenCalledWith({ mode: 'detach' });
    expect(screen.getByText('DevTools 已打开（detach）')).toBeTruthy();
  });

  it('ok=false：提示 sender 窗口不存在', async () => {
    mockOpenDevtools.mockResolvedValue({ data: { ok: false, mode: 'right' } });
    render(<InspectorPanel />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('以右侧 模式打开 DevTools'));
    });
    expect(screen.getByText('打开失败：sender 窗口不存在')).toBeTruthy();
  });

  it('IPC 抛错（协议异常）：展示原始错误消息', async () => {
    mockOpenDevtools.mockResolvedValue({
      error: { code: 'DEVTOOLS_OPEN_FAILED', message: '窗口已销毁' },
    });
    render(<InspectorPanel />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('以底部 模式打开 DevTools'));
    });
    expect(screen.getByText(/DEVTOOLS_OPEN_FAILED/)).toBeTruthy();
  });

  it('IPC 以非 Error 拒绝：回退为字符串展示（reject 值不受类型约束）', async () => {
    mockOpenDevtools.mockRejectedValue('ipc channel closed');
    render(<InspectorPanel />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('以独立窗口 模式打开 DevTools'));
    });
    expect(screen.getByText('ipc channel closed')).toBeTruthy();
  });

  it('调用中：按钮全部禁用', async () => {
    let resolveOpen: ((value: unknown) => void) | undefined;
    mockOpenDevtools.mockReturnValue(
      new Promise((resolve) => {
        resolveOpen = resolve;
      }),
    );
    render(<InspectorPanel />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('以独立窗口 模式打开 DevTools'));
    });
    expect(screen.getByLabelText('以右侧 模式打开 DevTools')).toBeDisabled();
    await act(async () => {
      resolveOpen?.({ data: { ok: true, mode: 'detach' } });
    });
  });

  it('状态自动清除：3 秒后回到 idle', async () => {
    vi.useFakeTimers();
    try {
      mockOpenDevtools.mockResolvedValue({ data: { ok: true, mode: 'detach' } });
      render(<InspectorPanel />);
      await act(async () => {
        fireEvent.click(screen.getByLabelText('以独立窗口 模式打开 DevTools'));
      });
      expect(screen.getByText('DevTools 已打开（detach）')).toBeTruthy();
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.queryByText('DevTools 已打开（detach）')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('卸载：清理状态清除定时器（不产生卸载后 setState）', async () => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, 'error');
    try {
      mockOpenDevtools.mockResolvedValue({ data: { ok: true, mode: 'detach' } });
      const { unmount } = render(<InspectorPanel />);
      await act(async () => {
        fireEvent.click(screen.getByLabelText('以独立窗口 模式打开 DevTools'));
      });
      unmount();
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });

  it('连续两次调用：上一次的清除定时器被替换（不会提前清掉新状态）', async () => {
    vi.useFakeTimers();
    try {
      mockOpenDevtools.mockResolvedValue({ data: { ok: true, mode: 'detach' } });
      render(<InspectorPanel />);
      await act(async () => {
        fireEvent.click(screen.getByLabelText('以独立窗口 模式打开 DevTools'));
      });
      // 第一次调用后 2.5s（未到 3s 清除点）再次调用 → 覆盖上一次定时器
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      mockOpenDevtools.mockResolvedValue({ data: { ok: false, mode: 'right' } });
      await act(async () => {
        fireEvent.click(screen.getByLabelText('以右侧 模式打开 DevTools'));
      });
      expect(screen.getByText('打开失败：sender 窗口不存在')).toBeTruthy();
      // 距第一次点击已 5s：若旧定时器未被清理，状态会在 3s 处被清空 → 此处断言它仍在
      await act(async () => {
        vi.advanceTimersByTime(2500);
      });
      expect(screen.getByText('打开失败：sender 窗口不存在')).toBeTruthy();
      // 第二次点击后满 3s 才清除
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(screen.queryByText('打开失败：sender 窗口不存在')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
