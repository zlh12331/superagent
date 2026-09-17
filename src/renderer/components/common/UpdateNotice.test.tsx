// src/renderer/components/common/__tests__/UpdateNotice.test.tsx
// UpdateNotice 更新提示单测：分阶段 toast + 同阶段防重入 + 静默阶段
// ──────────────────────────────────────────────
// 覆盖动机：组件此前 0% 覆盖。它是更新流程的唯一用户可见出口——
// 阶段 → toast 类型的映射（available→info / downloaded→带安装动作 /
// not-available→success / error→error）、downloading/checking 静默、
// lastNotifiedPhaseRef 防重复推送，均无回归锚。
// 集成方式：mock useUpdate 返回状态（真实 toast 由 sonner mock 断言）。
// ──────────────────────────────────────────────

import { render } from '@testing-library/react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UpdateNotice } from './UpdateNotice';

const mockState = vi.hoisted(() => ({
  value: null as null | { phase: string; version?: string; message?: string },
}));
const installSpy = vi.hoisted(() => vi.fn());

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-update', () => ({
  useUpdate: (): { state: typeof mockState.value; install: typeof installSpy } => ({
    state: mockState.value,
    install: installSpy,
  }),
}));

describe('UpdateNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.value = null;
  });

  it('纯事件消费：不渲染任何 DOM（返回 null）', () => {
    const { container } = render(<UpdateNotice />);
    expect(container.firstChild).toBeNull();
  });

  it('state 为 null（未订阅到状态）→ 不弹任何 toast', () => {
    render(<UpdateNotice />);
    expect(toast).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('available：info toast（含下载中描述与版本号）', () => {
    mockState.value = { phase: 'available', version: '1.2.3' };
    render(<UpdateNotice />);
    expect(toast.info).toHaveBeenCalledTimes(1);
    const [message, options] = vi.mocked(toast.info).mock.calls[0] as [
      string,
      { description: string },
    ];
    expect(message).toContain('发现');
    expect(options.description).toContain('1.2.3');
  });

  it('downloaded：带「立即重启」动作的 toast（action.onClick 调 install）', () => {
    mockState.value = { phase: 'downloaded', version: '1.2.3' };
    render(<UpdateNotice />);
    expect(toast).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(toast).mock.calls[0] as unknown as [
      string,
      { action: { onClick: () => void }; duration: number },
    ];
    expect(options.duration).toBe(60_000);
    options.action.onClick();
    expect(installSpy).toHaveBeenCalledTimes(1);
  });

  it('not-available：success toast（已是最新）', () => {
    mockState.value = { phase: 'not-available' };
    render(<UpdateNotice />);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });

  it('error：error toast（含 message 描述）', () => {
    mockState.value = { phase: 'error', message: '网络不可达' };
    render(<UpdateNotice />);
    expect(toast.error).toHaveBeenCalledTimes(1);
    const [, options] = vi.mocked(toast.error).mock.calls[0] as [string, { description: string }];
    expect(options.description).toBe('网络不可达');
  });

  it('异常边界：error 阶段但 message 缺失 → 回退通用未知错误文案', () => {
    mockState.value = { phase: 'error' };
    render(<UpdateNotice />);
    const [, options] = vi.mocked(toast.error).mock.calls[0] as [string, { description: string }];
    expect(options.description.length).toBeGreaterThan(0);
  });

  it('静默阶段：checking / downloading 不弹任何 toast（进度高频避免刷屏）', () => {
    mockState.value = { phase: 'checking' };
    const { unmount } = render(<UpdateNotice />);
    expect(toast).not.toHaveBeenCalled();
    unmount();
    mockState.value = { phase: 'downloading' };
    render(<UpdateNotice />);
    expect(toast).not.toHaveBeenCalled();
  });

  it('防重入：同阶段状态重渲染不重复弹（lastNotifiedPhaseRef）', () => {
    mockState.value = { phase: 'not-available' };
    const { rerender } = render(<UpdateNotice />);
    expect(toast.success).toHaveBeenCalledTimes(1);
    rerender(<UpdateNotice />);
    rerender(<UpdateNotice />);
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
});
