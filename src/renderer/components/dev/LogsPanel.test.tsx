// src/renderer/components/dev/LogsPanel.test.tsx
// LogsPanel 单测/集成（四态渲染 / 过滤与行数交互 / 刷新与禁用语义）
// ──────────────────────────────────────────────────────────────
// 策略：mock `@/hooks/use-system`（数据获取边界，沿用 GitPanel 测试的做法），
// 组件自身逻辑走真实实现。（原 dev-panels.test 按被测组件拆分至此）
// ──────────────────────────────────────────────────────────────

import type { ReadLogsRes } from '@code-agent/shared/renderer';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockUseLogsReadQuery, mockUseSystemStatusQuery, mockRefetchLogs } = vi.hoisted(() => ({
  mockUseLogsReadQuery: vi.fn(),
  mockUseSystemStatusQuery: vi.fn(),
  mockRefetchLogs: vi.fn(),
}));

vi.mock('@/hooks/use-system', () => ({
  useLogsReadQuery: mockUseLogsReadQuery,
  useSystemStatusQuery: mockUseSystemStatusQuery,
}));

import { LogsPanel } from './LogsPanel';

const LOGS_SAMPLE: ReadLogsRes = {
  lines: ['[info] started', '[error] boom', '[warn] careful'],
  total: 3,
  filePath: '/tmp/main.log',
  truncated: false,
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

/** 最近一次 useLogsReadQuery 调用参数（lines, level, enabled） */
function lastLogsArgs(): readonly unknown[] {
  return (mockUseLogsReadQuery.mock.calls.at(-1) ?? []) as readonly unknown[];
}

beforeEach(() => {
  vi.clearAllMocks();
  setLogsState();
});

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
