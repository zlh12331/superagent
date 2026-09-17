// src/renderer/components/dev/InspectorPanel.test.tsx
// InspectorPanel 单测（停靠模式 IPC 分流 / 状态自动清除 / 卸载清理）
// 策略：mock window.api.devtools（IPC 边界），组件自身逻辑走真实实现。
// （原 dev-panels.test 按被测组件拆分至此）

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockOpenDevtools } = vi.hoisted(() => ({ mockOpenDevtools: vi.fn() }));

import { InspectorPanel } from './InspectorPanel';

describe('InspectorPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
